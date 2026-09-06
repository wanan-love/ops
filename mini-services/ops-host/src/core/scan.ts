import { promises as fs } from 'node:fs'
import { PDFDocument } from 'pdf-lib'
import type { FileStorage } from './storage'
import type { EventBus } from './eventbus'
import type { EventLog } from './eventlog'
import type { DiscoveredIpPrinter, ScanDevice, ScanJob } from './types'
import type { VirtualScanServer } from '../vscan/server'
import { EsclClient, EsclHttpError } from '../backends/escl/client'

/**
 * ScanManager — 扫描域管理器（P3 · eSCL + P3.5 按需 PDF 导出）。
 *
 * 职责：
 *  - 扫描设备列表（vscan 静态档案 + 手动添加 manual + mDNS 实时发现）
 *  - 扫描任务生命周期：createScanJob（eSCL POST）→ 后台逐页取图（NextDocument，
 *    409 未就绪重试 / 404 取完）→ 每页落盘 scan-jobs/{id}/page-{n}.png → completed
 *  - 取消（eSCL DELETE，幂等）/ 删除（元数据 + 图像目录）
 *  - 按需 PDF 导出（P3.5）：completed 任务多页 PNG → pdf-lib 合成，A4 等比适配
 *    居中（横图自动横向页）→ 落盘 scan-jobs/{id}/document.pdf，幂等复用缓存
 *  - 状态变化经 bus 'scan:update' 广播（WS 实时层转发）
 *
 * 持久化（复用 FileStorage 目录约定，node:fs 直写二进制）：
 *  - scan-devices.json           手动添加的扫描仪
 *  - scan-jobs/{id}/job.json     ScanJob + eSCL jobUrl
 *  - scan-jobs/{id}/page-n.png   每页图像
 *  - scan-jobs/{id}/document.pdf 按需导出的合成 PDF（删任务随目录清理）
 */

/** job.json 落盘形态：ScanJob + eSCL 任务 URL（取消/排查用，不出现在 API 响应） */
interface StoredScanJob {
  job: ScanJob
  esclJobUrl: string | null
}

export interface ScanManagerOptions {
  storage: FileStorage
  bus: EventBus
  log: EventLog
  /** mDNS _uscan 实时扫描（host 装配注入；缺省 = mDNS 不可用） */
  scanUscan?: () => Promise<DiscoveredIpPrinter[]>
}

/** 稳定短哈希（mDNS 发现设备的确定性 id，同一实例多次扫描 id 不变） */
function shortHash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

export class ScanManager {
  private readonly escl = new EsclClient({ timeoutMs: 8000 })
  private readonly jobs = new Map<string, StoredScanJob>()
  private manualDevices: ScanDevice[] = []

  constructor(private readonly opts: ScanManagerOptions) {}

  // ---------------------------------------------------------------- 加载 / 持久化

  /** Host 启动：恢复手动设备与历史任务（进行中任务标记失败 —— Host 重启中断） */
  async load(): Promise<void> {
    const data = await this.opts.storage.readJson<{ devices?: ScanDevice[] } | null>('scan-devices.json', null)
    this.manualDevices = Array.isArray(data?.devices) ? data!.devices! : []
    const dir = this.opts.storage.path('scan-jobs')
    let entries: Array<{ name: string; isDirectory: () => boolean }> = []
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      entries = []
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const stored = await this.opts.storage.readJson<StoredScanJob | null>(`scan-jobs/${entry.name}/job.json`, null)
      if (!stored?.job?.id) continue
      if (stored.job.state === 'pending' || stored.job.state === 'scanning') {
        // 重启中断：置为 failed（幂等恢复，不继续轮询 —— eSCL 任务在服务端已失效）
        stored.job.state = 'failed'
        stored.job.error = 'Host 重启导致扫描中断'
        stored.job.finishedAt = new Date().toISOString()
        stored.job.durationMs = new Date(stored.job.finishedAt).getTime() - new Date(stored.job.startedAt).getTime()
        await this.persistJob(stored)
      }
      this.jobs.set(stored.job.id, stored)
    }
  }

  private async persistJob(stored: StoredScanJob): Promise<void> {
    await this.opts.storage.writeJson(`scan-jobs/${stored.job.id}/job.json`, stored)
  }

  private async persistDevices(): Promise<void> {
    await this.opts.storage.writeJson('scan-devices.json', { devices: this.manualDevices })
  }

  // ---------------------------------------------------------------- 设备

  /** 设备列表：vscan 静态档案（含双面能力）+ 手动添加（mdns 结果不持久化，由 mdnsScan 实时返回） */
  async listDevices(vscan: VirtualScanServer | null): Promise<ScanDevice[]> {
    const out: ScanDevice[] = []
    const now = new Date().toISOString()
    if (vscan) {
      for (const info of vscan.list()) {
        let host = '127.0.0.1'
        let port = vscan.port
        try {
          const u = new URL(info.baseUrl)
          host = u.hostname
          port = Number(u.port) || port
        } catch {
          /* 保底 127.0.0.1 */
        }
        out.push({ id: info.id, name: info.name, host, port, baseUrl: info.baseUrl, source: 'vscan', duplexCap: info.duplex ? 'yes' : 'no', lastSeenAt: now })
      }
    }
    out.push(...this.manualDevices)
    return out
  }

  /** mDNS 实时发现（_uscan._tcp）→ ScanDevice（去重：同 baseUrl+实例名已在 manual/vscan 则跳过；同一 baseUrl 可承载多个档案，如 vscan-flatbed/adf） */
  async mdnsScan(vscan: VirtualScanServer | null): Promise<ScanDevice[]> {
    if (!this.opts.scanUscan) return []
    const found = await this.opts.scanUscan()
    const now = new Date().toISOString()
    // 去重键 = baseUrl + 实例名（同端口多档案不互斥；不同来源/地址的同一台无法断定则保留展示）
    const known = new Set((await this.listDevices(vscan)).map((d) => `${d.baseUrl}|${d.name}`))
    const out: ScanDevice[] = []
    for (const p of found) {
      const key = `${p.uri}|${p.name}`
      if (known.has(key)) continue
      known.add(key)
      let host = p.ip
      let port = p.port
      try {
        const u = new URL(p.uri)
        host = u.hostname
        port = Number(u.port) || port
      } catch {
        /* 用 A 记录 ip */
      }
      out.push({
        id: `uscan-${shortHash(`${p.uri}|${p.name}`)}`,
        name: p.name,
        host,
        port,
        baseUrl: p.uri,
        source: 'mdns',
        txt: p.txt,
        lastSeenAt: now,
      })
    }
    return out
  }

  /** 手动添加：EsclClient.getScannerStatus 探活（失败 throw）+ 双面能力探测（三态，不抛错），持久化 scan-devices.json */
  async addDevice(baseUrl: string, name?: string): Promise<ScanDevice> {
    const base = baseUrl.trim().replace(/\/+$/, '')
    if (!/^https?:\/\//i.test(base)) throw new Error('baseUrl 必须以 http:// 或 https:// 开头')
    if (this.manualDevices.some((d) => d.baseUrl === base)) throw new Error(`扫描仪已添加（baseUrl 重复：${base}）`)
    // 探活：GET {base}/eSCL/ScannerStatus（传输/HTTP 错误原样抛给路由层）
    const status = await this.escl.getScannerStatus(base)
    // 双面能力探测（能力三态：探测失败 ≠ 不支持，归 unknown，不抛错）
    const caps = await this.escl.getScannerCapabilities(base).catch(() => ({ duplex: 'unknown' as const, raw: '' }))
    let host = 'unknown'
    let port = 80
    try {
      const u = new URL(base)
      host = u.hostname
      port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80)
    } catch {
      /* 已由正则保证可解析 */
    }
    const device: ScanDevice = {
      id: `scan-dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name: (name && name.trim() !== '' ? name.trim() : `${host} eSCL Scanner`).slice(0, 80),
      host,
      port,
      baseUrl: base,
      source: 'manual',
      txt: { state: status.state },
      duplexCap: caps.duplex,
      lastSeenAt: new Date().toISOString(),
    }
    this.manualDevices.push(device)
    await this.persistDevices()
    const duplexLabel = caps.duplex === 'yes' ? '支持双面' : caps.duplex === 'no' ? '不支持双面' : '双面能力未知（ScannerCapabilities 无 Duplex）'
    this.opts.log.record({ type: 'discovery', topic: 'scan', message: `手动添加扫描设备：${device.name}（${base}，ScannerStatus=${status.state}，${duplexLabel}）` })
    return device
  }

  /** 删除手动设备（仅 manual 可删；返回 false = 不存在或非 manual） */
  async removeDevice(id: string): Promise<boolean> {
    const idx = this.manualDevices.findIndex((d) => d.id === id)
    if (idx < 0) return false
    const [removed] = this.manualDevices.splice(idx, 1)
    await this.persistDevices()
    this.opts.log.record({ type: 'discovery', topic: 'scan', message: `已移除扫描设备：${removed?.name ?? id}` })
    return true
  }

  // ---------------------------------------------------------------- 任务

  /** 提交扫描：eSCL CreateScanJob → 后台异步逐页取图（立即返回 202 语义的 job） */
  async startScan(
    device: ScanDevice,
    opts: { format: 'image/png' | 'application/pdf'; dpi: number; colorMode: 'RGB' | 'Grayscale'; inputSource: 'Platen' | 'Feeder'; duplex?: boolean },
  ): Promise<ScanJob> {
    // 语义校验：双面仅对送稿器有效（与 vscan / 真实 eSCL 设备行为一致）
    if (opts.duplex && opts.inputSource !== 'Feeder') {
      throw new Error('双面扫描仅支持送稿器（Feeder）输入源：平板无法双面扫描')
    }
    const duplex = opts.duplex === true
    const job: ScanJob = {
      id: `scan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      deviceId: device.id,
      deviceName: device.name,
      state: 'pending',
      format: opts.format,
      dpi: opts.dpi,
      colorMode: opts.colorMode,
      inputSource: opts.inputSource,
      duplex,
      pagesDone: 0,
      // 先按 inputSource+duplex 推定（Feeder 单面 2 / 双面 4，Platen 1），实际以取页为准，完成后 pagesTotal=pagesDone
      pagesTotal: opts.inputSource === 'Feeder' ? (duplex ? 4 : 2) : 1,
      images: [],
      pageSides: duplex ? [] : undefined,
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: null,
    }
    // 创建远端 eSCL 任务（失败 → 抛错，路由层转 400/502）
    const { jobUrl } = await this.escl.createScanJob(device.baseUrl, {
      format: opts.format,
      dpi: opts.dpi,
      colorMode: opts.colorMode,
      inputSource: opts.inputSource,
      duplex,
    })
    job.state = 'scanning'
    const stored: StoredScanJob = { job, esclJobUrl: jobUrl }
    this.jobs.set(job.id, stored)
    await this.persistJob(stored)
    this.opts.bus.emit('scan:update', { job })
    this.opts.log.record({
      type: 'job',
      topic: `scan:${job.state}`,
      message: `扫描任务已提交：${job.id}（${device.name}，${opts.dpi}dpi ${opts.colorMode} ${opts.inputSource}${duplex ? ' 双面' : ''}）`,
      data: { jobId: job.id, deviceId: device.id, esclJobUrl: jobUrl, duplex },
    })
    void this.runScanJob(stored, device)
    return job
  }

  /** 后台逐页取图循环：409 重试（总超时 30s）→ 404 = 结束 → 每页落盘 + 广播 */
  private async runScanJob(stored: StoredScanJob, device: ScanDevice): Promise<void> {
    const { job } = stored
    const url = stored.esclJobUrl ?? ''
    try {
      await new Promise((resolve) => setTimeout(resolve, 600))
      const deadline = Date.now() + 30_000
      for (;;) {
        if (job.state === 'cancelled') return // cancelJob 已置终态，后台循环静默退出
        if (Date.now() > deadline) throw new Error('取页总超时（30s）')
        let page: Uint8Array
        try {
          const res = await this.escl.getNextDocument(device.baseUrl, url)
          page = res.data
        } catch (err) {
          if (err instanceof EsclHttpError && err.status === 404) break // 没有更多页面
          if (err instanceof EsclHttpError && err.status === 409) {
            await new Promise((resolve) => setTimeout(resolve, 300)) // 页面未就绪 → 重试
            continue
          }
          throw err
        }
        const n = job.pagesDone + 1
        const filePath = this.opts.storage.path(`scan-jobs/${job.id}/page-${n}.png`)
        await fs.mkdir(this.opts.storage.path(`scan-jobs/${job.id}`), { recursive: true })
        await fs.writeFile(filePath, page)
        job.pagesDone = n
        job.images.push(`page-${n}.png`)
        // 双面任务：与 vscan / 真实 ADF 一致，奇数页正面、偶数页背面（纸1正/纸1反/纸2正/纸2反）
        if (job.pageSides) job.pageSides.push(n % 2 === 1 ? 'front' : 'back')
        await this.persistJob(stored)
        this.opts.bus.emit('scan:update', { job })
        if (job.state === 'cancelled') return // 取消发生在取页飞行中：保留已取页数后退出
      }
      // 全部页取完
      job.state = 'completed'
      job.pagesTotal = job.pagesDone
      job.finishedAt = new Date().toISOString()
      job.durationMs = new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime()
      await this.persistJob(stored)
      this.opts.bus.emit('scan:update', { job })
      this.opts.log.record({
        type: 'job',
        topic: `scan:${job.state}`,
        message: `扫描完成：${job.id}（${job.pagesDone} 页，${job.durationMs}ms，${device.name}）`,
        data: { jobId: job.id },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      job.state = 'failed'
      job.error = message
      job.finishedAt = new Date().toISOString()
      job.durationMs = new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime()
      await this.persistJob(stored)
      this.opts.bus.emit('scan:update', { job })
      this.opts.log.record({
        type: 'job',
        topic: 'scan:failed',
        message: `扫描失败：${job.id}（${message}）`,
        data: { jobId: job.id },
      })
    }
  }

  listJobs(): ScanJob[] {
    return [...this.jobs.values()].map((s) => ({ ...s.job }))
  }

  getJob(id: string): ScanJob | null {
    const stored = this.jobs.get(id)
    return stored ? { ...stored.job } : null
  }

  /** 取消（eSCL DELETE；已终态幂等返回当前状态） */
  async cancelJob(id: string): Promise<ScanJob> {
    const stored = this.jobs.get(id)
    if (!stored) throw new Error(`扫描任务不存在：${id}`)
    const { job } = stored
    if (job.state === 'completed' || job.state === 'failed' || job.state === 'cancelled') {
      return { ...job } // 幂等
    }
    job.state = 'cancelled'
    job.finishedAt = new Date().toISOString()
    job.durationMs = new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime()
    await this.persistJob(stored)
    this.opts.bus.emit('scan:update', { job })
    this.opts.log.record({ type: 'job', topic: 'scan:cancelled', message: `扫描已取消：${job.id}（已取 ${job.pagesDone}/${job.pagesTotal} 页）`, data: { jobId: job.id } })
    // 通知远端 eSCL 服务取消（best-effort：失败不影响本地终态，后台循环按 state 退出）
    if (stored.esclJobUrl) {
      try {
        await this.escl.cancelScanJob('', stored.esclJobUrl) // jobUrl 为绝对 URL，baseUrl 占位
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.warn(`[scan] eSCL 取消失败（任务 ${job.id}，不影响本地终态）：${message}`)
      }
    }
    return { ...job }
  }

  /** 删除任务（元数据 + 图像目录） */
  async removeJob(id: string): Promise<boolean> {
    const stored = this.jobs.get(id)
    if (!stored) return false
    this.jobs.delete(id)
    await this.opts.storage.remove(`scan-jobs/${id}`)
    return true
  }

  /** 读取某页 PNG 字节（1-based；不存在返回 null） */
  async getJobImageBytes(job: ScanJob, pageIndex: number): Promise<Buffer | null> {
    const rel = job.images[pageIndex - 1]
    if (!rel) return null
    try {
      return await fs.readFile(this.opts.storage.path(`scan-jobs/${job.id}/${rel}`))
    } catch {
      return null
    }
  }

  // ---------------------------------------------------------------- PDF 导出（P3.5）

  /**
   * 按需导出 PDF：completed 任务的全量 PNG 页 → pdf-lib 合成 A4（横图自动横向页，
   * 等比适配居中、18pt 边距）→ 落盘 scan-jobs/{id}/document.pdf。
   * 幂等：job.pdf 元数据存在且 document.pdf 可读 → 直接返回（不重复合成）。
   */
  async exportJobPdf(id: string): Promise<ScanJob> {
    const stored = this.jobs.get(id)
    if (!stored) throw new Error(`扫描任务不存在：${id}`)
    const { job } = stored
    if (job.state !== 'completed') {
      throw new Error(`仅已完成的扫描任务可导出 PDF（当前状态：${job.state}）`)
    }
    if (job.images.length === 0) throw new Error('任务无图像页可导出')
    // 幂等复用：元数据 + 文件均在 → 直接返回
    if (job.pdf) {
      const cached = await this.getJobPdfBytes(job)
      if (cached) {
        this.opts.log.record({ type: 'job', topic: 'scan:pdf', message: `PDF 导出复用缓存：${job.id}（${job.pdf.pages} 页，${job.pdf.bytes} bytes）`, data: { jobId: job.id } })
        return { ...job }
      }
    }

    const started = Date.now()
    const doc = await PDFDocument.create()
    doc.setTitle(`OPS Scan ${job.id}`)
    doc.setProducer('OpenPrintShare Scan PDF Export')
    doc.setCreator('OpenPrintShare Host')
    doc.setCreationDate(new Date(job.startedAt))
    // A4 尺寸（pt）；边距
    const A4_W = 595.28
    const A4_H = 841.89
    const MARGIN = 18
    for (let i = 0; i < job.images.length; i++) {
      const png = await this.getJobImageBytes(job, i + 1)
      if (!png) throw new Error(`第 ${i + 1} 页图像缺失（${job.images[i]}）`)
      const image = await doc.embedPng(png)
      const { width: iw, height: ih } = image.scale(1)
      // 横图 → 横向 A4；竖图 → 纵向 A4（每页独立判定，混合方向任务正确排版）
      const landscape = iw > ih
      const pw = landscape ? A4_H : A4_W
      const ph = landscape ? A4_W : A4_H
      const page = doc.addPage([pw, ph])
      const availW = pw - MARGIN * 2
      const availH = ph - MARGIN * 2
      const scale = Math.min(availW / iw, availH / ih)
      const drawW = iw * scale
      const drawH = ih * scale
      page.drawImage(image, {
        x: (pw - drawW) / 2,
        y: (ph - drawH) / 2,
        width: drawW,
        height: drawH,
      })
    }
    const bytes = await doc.save()
    const pdfPath = this.opts.storage.path(`scan-jobs/${job.id}/document.pdf`)
    await fs.mkdir(this.opts.storage.path(`scan-jobs/${job.id}`), { recursive: true })
    await fs.writeFile(pdfPath, bytes)

    job.pdf = {
      exportedAt: new Date().toISOString(),
      pages: job.images.length,
      bytes: bytes.byteLength,
      durationMs: Date.now() - started,
    }
    await this.persistJob(stored)
    this.opts.bus.emit('scan:update', { job })
    this.opts.log.record({
      type: 'job',
      topic: 'scan:pdf',
      message: `扫描任务已导出 PDF：${job.id}（${job.pdf.pages} 页，${job.pdf.bytes} bytes，${job.pdf.durationMs}ms）`,
      data: { jobId: job.id },
    })
    return { ...job }
  }

  /** 读取导出的 PDF 字节（未导出或文件缺失返回 null） */
  async getJobPdfBytes(job: ScanJob): Promise<Buffer | null> {
    if (!job.pdf) return null
    try {
      return await fs.readFile(this.opts.storage.path(`scan-jobs/${job.id}/document.pdf`))
    } catch {
      return null
    }
  }
}
