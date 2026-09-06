import type { BackendKind, CapabilityReport, PrinterStatus } from '../core/types'
import type { BackendJobStatus, BackendPrinterRef, PrinterBackend, SubmitJobRequest } from './index'
import { promises as fs } from 'node:fs'
import { IppClient, IppUnsupportedSchemeError } from './ipp/client'
import { reportFromPrinterAttributes, reportFromError, statusFromPrinterAttributes } from './ipp/capabilities'

/**
 * IPPPrinterBackend — IPP 协议直连后端（RFC 8010/8011）。
 *
 * 本阶段打印机枚举策略：
 *  - 静态注册的 Virtual IPP 打印机（baseUri/printers/<id>，vipp-full 等 4 台档案）
 *  - 用户手动添加的 IPP URI（POST /api/printers/add-uri，持久化到 dataDir）
 *  - 真实 CUPS 队列的枚举由 CupsPrinterBackend 负责
 *
 * 能力探测：真实调用 Get-Printer-Attributes → CapabilityReport：
 *  - 属性存在 → supported/unsupported；属性缺失 → unknown（读取不到 ≠ 不支持）
 *  - ipps://（TLS，自签名容忍 TOFU）→ https 传输
 *
 * 容错：getJobStatus 出错 → state 'unknown'（不抛异常炸队列）；getStatus 出错 → 抛给状态同步循环计数。
 */
export interface IPPPrinterBackendOptions {
  /** 如 ipp://localhost:3061 */
  baseUri: string
  /** 静态打印机 id 列表（默认 vipp 4 档案） */
  staticPrinterIds?: string[]
  /** 手动 URI 注册表持久化位置 */
  registryFile?: string
  timeoutMs?: number
}

interface AddedUriEntry {
  uri: string
  displayName: string
  note?: string
}

export class IPPPrinterBackend implements PrinterBackend {
  readonly kind: BackendKind = 'ipp'
  /** 动态说明：开发模式下含 Virtual IPP 对接信息（vipp 存在时）；正式模式只描述真实能力（运行时决定，不烘焙环境） */
  get availabilityNote(): string {
    const devNote =
      this.staticPrinterIds.length > 0
        ? `开发/测试模式（OPS_DEV_MODE=1）：对接本机 Virtual IPP Server（${this.baseUri}，${this.staticPrinterIds.length} 台虚拟打印机）。`
        : ''
    return [
      'IPP 直连后端（RFC 8010/8011 自研协议栈）：通过 Get-Printer-Attributes 探测能力、Print-Job 提交 PDF；支持 ipps://（TLS，自签名容忍 TOFU）；可手动添加 ipp:// URI 直连局域网 IPP 打印机。',
      devNote,
      '探测状态以 available() 实时探测为准（无可用 IPP 目标时不可用——如实报告，不伪造可用性）。',
    ]
      .filter(Boolean)
      .join('')
  }

  private readonly client: IppClient
  private readonly baseUri: string
  private readonly staticPrinterIds: string[]
  private readonly registryFile: string | null
  private readonly addedUris = new Map<string, AddedUriEntry>()
  private registryLoaded = false

  constructor(private readonly opts: IPPPrinterBackendOptions) {
    this.client = new IppClient({ timeoutMs: opts.timeoutMs ?? 5000, user: 'ops-host' })
    this.baseUri = opts.baseUri.replace(/\/$/, '')
    this.staticPrinterIds = opts.staticPrinterIds ?? ['vipp-full', 'vipp-basic', 'vipp-mono', 'vipp-minimal']
    this.registryFile = opts.registryFile ?? null
  }

  private async ensureRegistry(): Promise<void> {
    if (this.registryLoaded || !this.registryFile) return
    this.registryLoaded = true
    try {
      const raw = await fs.readFile(this.registryFile, 'utf8')
      const entries = JSON.parse(raw) as AddedUriEntry[]
      for (const entry of entries) this.addedUris.set(entry.uri, entry)
    } catch {
      /* 首次运行 */
    }
  }

  private async persistRegistry(): Promise<void> {
    if (!this.registryFile) return
    const tmp = `${this.registryFile}.${Date.now()}.tmp`
    await fs.writeFile(tmp, JSON.stringify([...this.addedUris.values()], null, 2))
    await fs.rename(tmp, this.registryFile)
  }

  /** 手动添加 IPP URI（如 ipp://192.168.1.50/ipp/print） */
  async addUri(uri: string, displayName?: string): Promise<AddedUriEntry> {
    const normalized = uri.replace(/\/$/, '')
    const name = displayName ?? hostOf(normalized) ?? normalized
    const entry = { uri: normalized, displayName: name, note: '手动添加的 IPP URI' }
    this.addedUris.set(normalized, entry)
    await this.ensureRegistry()
    await this.persistRegistry()
    return entry
  }

  async removeUri(uri: string): Promise<boolean> {
    await this.ensureRegistry()
    const existed = this.addedUris.delete(uri)
    if (existed) await this.persistRegistry()
    return existed
  }

  listAddedUris(): AddedUriEntry[] {
    return [...this.addedUris.values()]
  }

  /** key → 请求 URI：ipp:// 开头直接用；否则视为 baseUri 下的静态打印机 id */
  private resolveUri(key: string): string {
    if (/^ipps?:\/\//i.test(key) || /^https?:\/\//i.test(key)) return key
    return `${this.baseUri}/printers/${key}`
  }

  async available(): Promise<boolean> {
    // 探测静态列表第一台（Get-Printer-Attributes，短超时）
    const probeId = this.staticPrinterIds[0]
    if (!probeId) return this.addedUris.size > 0
    try {
      await this.client.getPrinterAttributes(this.resolveUri(probeId))
      return true
    } catch (err) {
      if (err instanceof IppUnsupportedSchemeError) return false
      return false
    }
  }

  async listPrinters(): Promise<BackendPrinterRef[]> {
    await this.ensureRegistry()
    const refs: BackendPrinterRef[] = []
    // 静态 vipp 打印机（不逐台探测，探测交给 getCapabilities/import）
    for (const id of this.staticPrinterIds) {
      refs.push({
        key: id,
        displayName: `OPS Virtual IPP ${labelOf(id)}`,
        description: `Virtual IPP Server 打印机（${id}）`,
        location: 'Virtual IPP 机房 3061',
        uri: `${this.baseUri}/printers/${id}`,
        makeAndModel: 'OpenPrintShare Virtual IPP Printer',
      })
    }
    for (const entry of this.addedUris.values()) {
      refs.push({
        key: entry.uri,
        displayName: entry.displayName,
        description: entry.note ?? '手动添加的 IPP 打印机',
        uri: entry.uri,
      })
    }
    return refs
  }

  async getPrinter(key: string): Promise<BackendPrinterRef | null> {
    const refs = await this.listPrinters()
    return refs.find((r) => r.key === key) ?? null
  }

  async getCapabilities(key: string): Promise<CapabilityReport> {
    const uri = this.resolveUri(key)
    const startedAt = Date.now()
    try {
      const msg = await this.client.getPrinterAttributes(uri)
      return reportFromPrinterAttributes(msg, 'IPP', Date.now() - startedAt)
    } catch (err) {
      const message = err instanceof IppUnsupportedSchemeError ? err.message : err instanceof Error ? err.message : String(err)
      return reportFromError('IPP', message, Date.now() - startedAt)
    }
  }

  async getStatus(key: string): Promise<{ status: PrinterStatus; message: string }> {
    const uri = this.resolveUri(key)
    const msg = await this.client.getPrinterAttributes(uri)
    return statusFromPrinterAttributes(msg)
  }

  async submitJob(req: SubmitJobRequest): Promise<{ jobId: string; jobUri?: string }> {
    const uri = this.resolveUri(req.printerKey)
    const result = await this.client.printJob(uri, req.pdf, req.jobName, req.userName, req.options)
    if (result.jobId === null) throw new Error('IPP Print-Job 响应缺少 job-id')
    return { jobId: String(result.jobId), jobUri: result.jobUri ?? undefined }
  }

  async getJobStatus(key: string, jobId: string): Promise<BackendJobStatus> {
    const uri = this.resolveUri(key)
    const numeric = Number(jobId)
    if (!Number.isInteger(numeric)) return { state: 'unknown', progress: 0, message: `后端任务 id 非法：${jobId}` }
    try {
      const snap = await this.client.getJobAttributes(uri, numeric)
      const progress =
        snap.impressionsTotal && snap.impressionsTotal > 0 && snap.impressionsCompleted !== null
          ? Math.min(100, Math.round((snap.impressionsCompleted / snap.impressionsTotal) * 100))
          : 0
      switch (snap.state) {
        case 3:
        case 4:
          return { state: 'pending', progress, message: `IPP job-state=${snap.state}（pending），reasons=[${snap.stateReasons.join(',')}]` }
        case 5:
          return { state: 'processing', progress, sheetsDone: snap.sheetsCompleted ?? undefined, message: `IPP job-state=5（processing）` }
        case 6:
          return { state: 'paused', progress, sheetsDone: snap.sheetsCompleted ?? undefined, message: snap.stateMessage ?? `IPP job-state=6（processing-stopped），reasons=[${snap.stateReasons.join(',')}]` }
        case 7:
          return { state: 'cancelled', progress, message: `IPP job-state=7（canceled）` }
        case 8:
          return { state: 'failed', progress, message: snap.stateMessage ?? `IPP job-state=8（aborted）` }
        case 9:
          return { state: 'completed', progress: 100, sheetsDone: snap.sheetsCompleted ?? undefined, message: `IPP job-state=9（completed）` }
        default:
          return { state: 'unknown', progress, message: `IPP job-state=${snap.state}（未知）` }
      }
    } catch (err) {
      // 轮询容错：不抛异常，state=unknown 交给 runner 记 warning
      return { state: 'unknown', progress: 0, message: err instanceof Error ? err.message : String(err) }
    }
  }

  async cancelJob(key: string, jobId: string): Promise<{ ok: boolean; message?: string }> {
    const uri = this.resolveUri(key)
    const numeric = Number(jobId)
    if (!Number.isInteger(numeric)) return { ok: false, message: `后端任务 id 非法：${jobId}` }
    try {
      await this.client.cancelJob(uri, numeric)
      return { ok: true, message: `IPP Cancel-Job 已发送（job ${jobId}）` }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // 终态任务取消 → not-possible，视为已取消完成（幂等）
      if (message.includes('not-possible') || message.includes('0x404')) {
        return { ok: true, message: `任务 ${jobId} 已处于终态（取消幂等）` }
      }
      return { ok: false, message }
    }
  }
}

function labelOf(id: string): string {
  const m = /-(\w+)$/.exec(id)
  if (!m) return id
  const word = m[1]!
  return word.charAt(0).toUpperCase() + word.slice(1)
}

function hostOf(uri: string): string | null {
  try {
    return new URL(uri).host
  } catch {
    return null
  }
}
