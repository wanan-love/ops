import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { BackendKind, CapabilityReport, PrintOptions, PrinterStatus } from '../core/types'
import type { BackendJobStatus, BackendPrinterRef, PrinterBackend, SubmitJobRequest } from './index'
import { IppClient } from './ipp/client'
import { reportFromPrinterAttributes, reportFromError, statusFromPrinterAttributes } from './ipp/capabilities'
import { detectRuntimePlatform, platformLabel } from '../core/runtime'

/**
 * CupsPrinterBackend — CUPS 后端（macOS / Linux 桌面与服务器）。
 *
 * 路径优先级：
 *  - 枚举：lpstat -p -l -d（queue / description / location）
 *  - 能力：IPP Get-PrinterAttributes → ipp://localhost:631/printers/<queue>（source: CUPS）
 *  - 提交：lp -d <queue> -n <copies> -o sides=… -o media=… -o print-color-mode=…；无 lp 时退回 IPP Print-Job 到 localhost:631
 *  - 状态：lpstat -W not-completed -o <queue> / IPP Get-Jobs
 *  - 取消：cancel <job-id>（精确，不用 cancel -a 粗暴清队列）
 *
 * 全部命令 8s 超时；命令不存在 → 优雅 unavailable。
 * availabilityNote 为 getter —— 访问时按运行时检测平台 + 探测状态生成，禁止烘焙开发/沙箱环境信息。
 */

const CUPS_TIMEOUT_MS = 8000

/** CLI 执行（超时 + 命令不存在优雅失败） */
export function runCmd(command: string, args: string[], timeoutMs = CUPS_TIMEOUT_MS): Promise<{ ok: boolean; code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      resolve({ ok: false, code: null, stdout: '', stderr: String(err) })
      return
    }
    let stdout = ''
    let stderr = ''
    let done = false
    const timer = setTimeout(() => {
      if (!done) {
        done = true
        child.kill('SIGKILL')
        resolve({ ok: false, code: null, stdout, stderr: `${stderr}\n(timeout after ${timeoutMs}ms)` })
      }
    }, timeoutMs)
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf8')
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8')
    })
    child.on('error', (err) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ok: false, code: null, stdout, stderr: err.message })
    })
    child.on('close', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ok: code === 0, code, stdout, stderr })
    })
  })
}

/** 探测命令是否可用（which） */
export async function commandExists(command: string): Promise<boolean> {
  const res = await runCmd('which', [command], 2000)
  return res.ok && res.stdout.trim() !== ''
}

/** lpstat -p -l 输出解析 */
export function parseLpstatPrinters(output: string, defaultQueue?: string | null): BackendPrinterRef[] {
  const refs: BackendPrinterRef[] = []
  const lines = output.split('\n')
  let current: { key: string; description: string; location: string } | null = null
  for (const line of lines) {
    const printerMatch = /^printer\s+(\S+)\s+is\s+(\S+)/.exec(line)
    if (printerMatch) {
      if (current) refs.push(finishRef(current, defaultQueue))
      current = { key: printerMatch[1]!, description: '', location: '' }
      continue
    }
    if (current) {
      const desc = /^\s*Description:\s*(.*)$/.exec(line)
      if (desc) {
        current.description = desc[1]!.trim()
        continue
      }
      const loc = /^\s*Location:\s*(.*)$/.exec(line)
      if (loc) {
        current.location = loc[1]!.trim()
        continue
      }
      const form = /^\s*Form:\s*/.exec(line)
      if (form) continue
    }
  }
  if (current) refs.push(finishRef(current, defaultQueue))
  return refs
}

/** lpstat -d 输出解析：`system default destination: X` / `no system default destination`（真实字段） */
export function parseLpstatDefault(output: string): string | null {
  const m = /system default destination:\s*(\S+)/.exec(output)
  return m?.[1] ?? null
}

function finishRef(current: { key: string; description: string; location: string }, defaultQueue?: string | null): BackendPrinterRef {
  return {
    key: current.key,
    displayName: current.key,
    description: current.description || `CUPS 打印队列 ${current.key}`,
    location: current.location,
    uri: `ipp://localhost:631/printers/${current.key}`,
    makeAndModel: 'CUPS Queue',
    // lpstat -d 读到系统默认队列时标记（读取不到 = null → 缺省不猜测）
    isDefault: defaultQueue ? current.key === defaultQueue : undefined,
    statusHint: defaultQueue === current.key ? 'system default destination' : undefined,
  }
}

/** lpstat -W not-completed -o <queue> 输出解析：`queue-jobid user bytes date` */
export function parseLpstatJobs(output: string): Array<{ jobId: string; queue: string; user: string }> {
  const jobs: Array<{ jobId: string; queue: string; user: string }> = []
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const m = /^(\S+)-(\d+)\s+(\S+)\s+(\d+)/.exec(trimmed)
    if (m) {
      jobs.push({ queue: m[1]!, jobId: m[2]!, user: m[3]! })
    }
  }
  return jobs
}

export interface CupsBackendOptions {
  /** CUPS 本地 IPP 端点 */
  cupsUri?: string
  /** CLI 临时文件目录（lp 打印 PDF 需要落盘） */
  tmpDir?: string
}

export class CupsPrinterBackend implements PrinterBackend {
  readonly kind: BackendKind = 'cups'

  /**
   * 动态可用性说明（getter —— 访问时按运行时检测平台 + 探测状态生成，不烘焙任何开发/沙箱环境信息）。
   * 环境事实（如「无 CUPS 守护进程」）由 available() 探测结果决定，而非固定文案。
   */
  get availabilityNote(): string {
    const p = detectRuntimePlatform()
    const probes: string[] = []
    if (this.availabilityCache === true) probes.push('已探测到 CUPS（ipp://localhost:631 可达或 lp/lpstat 可用）')
    else if (this.availabilityCache === false) probes.push('探测未通过（无 CUPS 守护进程或无 lp/lpstat 命令）')
    else probes.push('尚未探测（available() 调用后更新）')
    return [
      'CUPS/IPP 后端：需本机运行 CUPS 守护进程（macOS / Linux 桌面与服务器）。探测方式：ipp://localhost:631 Get-Printer-Attributes + which lpstat/lp。',
      `当前运行平台（运行时检测）：${platformLabel(p)}。探测状态：${probes.join('；')}。`,
      '枚举经 lpstat -p -l -d（含系统默认队列标记）；能力经 CUPS IPP 属性（真实协议数据）。',
    ].join('')
  }

  private readonly cupsUri: string
  private readonly tmpDir: string
  private readonly client = new IppClient({ timeoutMs: 5000, user: 'ops-host' })
  private lpstatAvailable = false
  private lpAvailable = false
  private availabilityCache: boolean | null = null

  constructor(opts: CupsBackendOptions = {}) {
    this.cupsUri = opts.cupsUri ?? 'ipp://localhost:631'
    this.tmpDir = opts.tmpDir ?? join(process.cwd(), 'data', 'tmp')
  }

  async available(): Promise<boolean> {
    // 双探测：IPP localhost:631（500ms 超时）+ which lpstat
    const probeClient = new IppClient({ timeoutMs: 500, user: 'ops-host' })
    let ippOk = false
    try {
      await probeClient.getPrinterAttributes(`${this.cupsUri}/printers/`, ['printer-name'])
      ippOk = true
    } catch {
      ippOk = false
    }
    this.lpstatAvailable = await commandExists('lpstat')
    this.lpAvailable = await commandExists('lp')
    this.availabilityCache = ippOk || (this.lpstatAvailable && this.lpAvailable)
    return this.availabilityCache
  }

  async listPrinters(): Promise<BackendPrinterRef[]> {
    if (this.lpstatAvailable) {
      const res = await runCmd('lpstat', ['-p', '-l', '-d'])
      if (res.ok) {
        // -d 输出含系统默认队列（真实字段；无默认时为 null）
        const refs = parseLpstatPrinters(res.stdout, parseLpstatDefault(res.stdout))
        if (refs.length > 0) return refs
      }
    }
    // 退路：无 lpstat → 尝试 CUPS IPP（CUPS-Get-Printers 属 CUPS 私有扩展，本阶段不实现）
    return []
  }

  async getPrinter(key: string): Promise<BackendPrinterRef | null> {
    const refs = await this.listPrinters()
    return refs.find((r) => r.key === key) ?? null
  }

  async getCapabilities(key: string): Promise<CapabilityReport> {
    const uri = `${this.cupsUri}/printers/${encodeURIComponent(key)}`
    const startedAt = Date.now()
    try {
      const msg = await this.client.getPrinterAttributes(uri)
      return reportFromPrinterAttributes(msg, 'CUPS', Date.now() - startedAt)
    } catch (err) {
      return reportFromError('CUPS', err instanceof Error ? err.message : String(err), Date.now() - startedAt)
    }
  }

  async getStatus(key: string): Promise<{ status: PrinterStatus; message: string }> {
    const uri = `${this.cupsUri}/printers/${encodeURIComponent(key)}`
    const msg = await this.client.getPrinterAttributes(uri)
    return statusFromPrinterAttributes(msg)
  }

  async submitJob(req: SubmitJobRequest): Promise<{ jobId: string; jobUri?: string }> {
    // 1) 优先 lp CLI
    if (this.lpAvailable) {
      const args = ['-d', req.printerKey, '-n', String(Math.max(1, Math.floor(req.options.copies)))]
      const sides = req.options.duplex === 'long-edge' ? 'two-sided-long-edge' : req.options.duplex === 'short-edge' ? 'two-sided-short-edge' : 'one-sided'
      args.push('-o', `sides=${sides}`)
      args.push('-o', `media=${req.options.paperSize}`)
      args.push('-o', `print-color-mode=${req.options.colorMode === 'color' ? 'color' : 'monochrome'}`)
      // 临时文件放 data 目录 tmp，打印后删除
      await fs.mkdir(this.tmpDir, { recursive: true })
      const tmpFile = join(this.tmpDir, `ops-${Date.now()}-${Math.floor(Math.random() * 1e6)}.pdf`)
      await fs.writeFile(tmpFile, req.pdf)
      try {
        const res = await runCmd('lp', [...args, tmpFile])
        if (res.ok) {
          // 输出形如 "request id is vp-1-262 (1 file(s))"
          const m = /request id is (\S+)/.exec(res.stdout)
          return { jobId: m?.[1] ?? `lp-${Date.now()}` }
        }
        // lp 失败（如打印机暂停）→ 抛给 runner 记失败
        throw new Error(`lp 提交失败：${res.stderr.trim() || res.stdout.trim()}`)
      } finally {
        void fs.rm(tmpFile, { force: true })
      }
    }
    // 2) 退回 IPP Print-Job（localhost:631）
    const result = await this.client.printJob(`${this.cupsUri}/printers/${encodeURIComponent(req.printerKey)}`, req.pdf, req.jobName, req.userName, req.options)
    if (result.jobId === null) throw new Error('CUPS IPP Print-Job 响应缺少 job-id')
    return { jobId: String(result.jobId), jobUri: result.jobUri ?? undefined }
  }

  async getJobStatus(key: string, jobId: string): Promise<BackendJobStatus> {
    // 1) lpstat（CLI 任务 id 形如 queue-N 或纯数字）
    if (this.lpstatAvailable) {
      const res = await runCmd('lpstat', ['-W', 'not-completed', '-o', key])
      if (res.ok) {
        const jobs = parseLpstatJobs(res.stdout)
        const found = jobs.find((j) => j.jobId === jobId || `${key}-${j.jobId}` === jobId)
        if (!found) {
          // 不在 not-completed 里 → 已完成（lpstat -W completed 确认）
          const doneRes = await runCmd('lpstat', ['-W', 'completed', '-o', key])
          const doneJobs = parseLpstatJobs(doneRes.stdout)
          const done = doneJobs.find((j) => j.jobId === jobId || `${key}-${j.jobId}` === jobId)
          return done
            ? { state: 'completed', progress: 100, message: 'CUPS 队列已无该任务（completed）' }
            : { state: 'unknown', progress: 0, message: `lpstat 未找到任务 ${jobId}` }
        }
        return { state: 'processing', progress: 0, message: `CUPS 任务 ${jobId} 打印中` }
      }
    }
    // 2) 退回 IPP Get-Jobs（数字 job-id）
    if (/^\d+$/.test(jobId)) {
      try {
        const jobs = await this.client.getJobs(`${this.cupsUri}/printers/${encodeURIComponent(key)}`)
        const mine = jobs.find((j) => j.jobId === Number(jobId))
        if (mine) {
          if (mine.state === 9) return { state: 'completed', progress: 100 }
          if (mine.state === 7) return { state: 'cancelled', progress: 0 }
          if (mine.state === 8) return { state: 'failed', progress: 0 }
          if (mine.state === 6) return { state: 'paused', progress: 0 }
          if (mine.state === 5) return { state: 'processing', progress: 0 }
          return { state: 'pending', progress: 0 }
        }
      } catch (err) {
        return { state: 'unknown', progress: 0, message: err instanceof Error ? err.message : String(err) }
      }
    }
    return { state: 'unknown', progress: 0, message: 'CUPS 任务状态未知（lpstat/IPP 均无法确认）' }
  }

  async cancelJob(key: string, jobId: string): Promise<{ ok: boolean; message?: string }> {
    // 精确取消单个任务（不用 cancel -a）
    if (await commandExists('cancel')) {
      const res = await runCmd('cancel', [jobId])
      if (res.ok) return { ok: true, message: `cancel ${jobId} 已执行` }
      // 幂等：任务已完成时 cancel 报错
      if (/unknown|already|completed|not\s+found/i.test(res.stderr)) {
        return { ok: true, message: `任务 ${jobId} 已不在队列中（取消幂等）` }
      }
      return { ok: false, message: `cancel 失败：${res.stderr.trim()}` }
    }
    if (/^\d+$/.test(jobId)) {
      try {
        await this.client.cancelJob(`${this.cupsUri}/printers/${encodeURIComponent(key)}`, Number(jobId))
        return { ok: true, message: `IPP Cancel-Job 已发送（job ${jobId}）` }
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
    }
    return { ok: false, message: 'cancel 命令不可用且 job-id 非 IPP 数字' }
  }
}
