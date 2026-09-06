import type { BackendKind, CapabilityReport, ConsumableInfo, PrinterStatus } from '../core/types'
import type { BackendJobStatus, BackendPrinterRef, PrinterBackend, SubmitJobRequest } from './index'
import { runCmd } from './cups'
import { emptyReport, failProbe, okProbe, supportedCap, unknownCap } from './merge'

/**
 * WindowsPrinterBackend — Win32 打印栈后端（代码完备，非 Windows 环境自动 unavailable）。
 *
 *  - 枚举：powershell Get-Printer | ConvertTo-Json -Compress
 *  - 能力：Get-CimInstance Win32_Printer（Capabilities 位掩码 + CapabilityDescriptions 字符串数组）
 *    位掩码（任务规格）：1 Other / 2 Unknown / 4 BlackAndWhite / 8 Color / 16 Duplex / 32 Copies / 64 Collate / 128 Stapled
 *    ⚠️ 墨量：WMI 无标准字段 → consumables state=unknown（严禁猜测）
 *  - 提交：PDF → Start-Process -FilePath <pdf> -Verb PrintTo '<printer>'（依赖系统默认 PDF 关联应用，
 *    如 Edge —— 这是 Windows 免驱打印 PDF 的标准做法，注明此限制）
 *  - 状态：Get-PrintJob（JobStatus: Normal/Paused/Error/Retained/Printing/Spooling/Completed…）
 *  - 取消：Remove-PrintJob
 *
 * 所有 PowerShell 调用 -NoProfile -NonInteractive -Command，8s 超时，JSON 输出解析健壮（单对象 vs 数组）。
 */

const PS_TIMEOUT_MS = 8000

interface WinPrinterRow {
  Name: string
  DriverName?: string
  PortName?: string
  Type?: number
  Shared?: boolean
  Published?: boolean
  PrinterStatus?: number
  WorkOffline?: boolean
}

interface Win32PrinterRow {
  Name: string
  Capabilities?: number[]
  CapabilityDescriptions?: string[]
  DefaultPaperType?: string
  HorizontalResolution?: number | null
  VerticalResolution?: number | null
  Comment?: string | null
  Location?: string | null
  PortName?: string | null
}

interface WinPrintJobRow {
  Id: number
  DocumentName?: string
  JobStatus?: string | string[]
  JobType?: number
  PrinterName?: string
  UserName?: string
  TotalPages?: number | null
  PrintedPages?: number | null
  SubmittedTime?: string
}

function toRows<T>(raw: string): T[] {
  const parsed = JSON.parse(raw) as T | T[] | null
  if (parsed === null) return []
  return Array.isArray(parsed) ? parsed : [parsed]
}

/** PowerShell 命令（统一 -NoProfile -NonInteractive -Command） */
async function powershell(script: string, timeoutMs = PS_TIMEOUT_MS): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const res = await runCmd('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], timeoutMs)
  return { ok: res.ok, stdout: res.stdout, stderr: res.stderr }
}

/** Win32_Printer.JobStatus（Get-PrintJob 的 JobStatus 字段）→ BackendJobStatus.state */
function mapWinJobStatus(status: string | string[] | undefined): BackendJobStatus['state'] {
  const list = Array.isArray(status) ? status : status ? [status] : []
  const joined = list.join(';').toLowerCase()
  if (joined.includes('completed')) return 'completed'
  if (joined.includes('error')) return 'failed'
  if (joined.includes('cancelled') || joined.includes('canceled') || joined.includes('deleted')) return 'cancelled'
  if (joined.includes('paused') || joined.includes('retained')) return 'paused'
  if (joined.includes('printing') || joined.includes('spooling') || joined.includes('normal')) return 'processing'
  if (joined.includes('pending')) return 'pending'
  return 'unknown'
}

export class WindowsPrinterBackend implements PrinterBackend {
  readonly kind: BackendKind = 'windows'
  readonly availabilityNote =
    'Windows Win32 打印栈后端：需在 Windows 宿主运行（Get-Printer / Win32_Printer / Start-Process -Verb PrintTo）。当前环境为 Linux → 不可用。注意：PDF 打印依赖系统默认 PDF 关联应用（如 Edge）'

  async available(): Promise<boolean> {
    return process.platform === 'win32'
  }

  async listPrinters(): Promise<BackendPrinterRef[]> {
    if (!(await this.available())) return []
    const res = await powershell("Get-Printer | Select-Object Name,DriverName,PortName,Type,Shared,Published | ConvertTo-Json -Compress")
    if (!res.ok) return []
    try {
      const rows = toRows<WinPrinterRow>(res.stdout.trim())
      return rows.map((row) => ({
        key: row.Name,
        displayName: row.Name,
        description: `${row.DriverName ?? '未知驱动'} @ ${row.PortName ?? '未知端口'}`,
        location: '',
        uri: `win32://printer/${encodeURIComponent(row.Name)}`,
        makeAndModel: row.DriverName,
      }))
    } catch {
      return []
    }
  }

  async getPrinter(key: string): Promise<BackendPrinterRef | null> {
    const refs = await this.listPrinters()
    return refs.find((r) => r.key === key) ?? null
  }

  async getCapabilities(key: string): Promise<CapabilityReport> {
    if (!(await this.available())) {
      return this.unavailableReport()
    }
    const startedAt = Date.now()
    const script = `Get-CimInstance Win32_Printer -Filter "Name='${key.replace(/'/g, "''")}'" | Select-Object Name,Capabilities,CapabilityDescriptions,DefaultPaperType,HorizontalResolution,VerticalResolution | ConvertTo-Json -Compress`
    const res = await powershell(script)
    const report = emptyReport('SYSTEM')
    if (!res.ok || res.stdout.trim() === '') {
      report.probes.push(failProbe('SYSTEM', Date.now() - startedAt, `Win32_Printer 查询失败：${res.stderr.trim() || '无输出'}`))
      return report
    }
    try {
      const row = toRows<Win32PrinterRow>(res.stdout.trim())[0]!
      const caps = row.Capabilities ?? []
      const descriptions = row.CapabilityDescriptions ?? []
      const has = (bit: number): boolean => caps.includes(bit)
      const descHas = (pattern: RegExp): boolean => descriptions.some((d) => pattern.test(d))

      // 颜色：位掩码 8=Color / 4=BlackAndWhite（同时出现时按描述字符串优先）
      const colorBit = has(8)
      const monoBit = has(4)
      if (colorBit && !monoBit) report.color = supportedCap(true, 'SYSTEM', 'Win32_Printer Capabilities: 8(Color)')
      else if (monoBit && !colorBit) report.color = supportedCap(false, 'SYSTEM', 'Win32_Printer Capabilities: 4(BlackAndWhite)')
      else if (descHas(/color/i)) report.color = supportedCap(true, 'SYSTEM', 'CapabilityDescriptions 含 "color"')
      else if (colorBit && monoBit) report.color = supportedCap(true, 'SYSTEM', 'Capabilities 同时含 4/8，描述判定为 color')
      else report.color = unknownCap('SYSTEM', 'Win32_Printer Capabilities 无法判定彩色')

      // 双面：位掩码 16=Duplex
      report.duplex = has(16) || descHas(/duplex|double/i)
        ? supportedCap('both', 'SYSTEM', 'Win32_Printer Capabilities: 16(Duplex)')
        : unknownCap('SYSTEM', 'Capabilities 无 Duplex 位（WMI 不区分长边/短边）')

      // 份数：位掩码 32=Copies
      report.maxCopies = has(32) || descHas(/copies/i)
        ? supportedCap(99, 'SYSTEM', 'Win32_Printer Capabilities: 32(Copies)（上限未知，保守 99）')
        : unknownCap('SYSTEM', 'Capabilities 无 Copies 位')

      // 纸张：DefaultPaperType（单个）+ Get-PrinterProperty 可扩展
      report.paperSizes = row.DefaultPaperType && row.DefaultPaperType.trim() !== ''
        ? supportedCap([row.DefaultPaperType.trim()], 'SYSTEM', `DefaultPaperType=${row.DefaultPaperType}`)
        : unknownCap('SYSTEM', 'Win32_Printer 无纸张尺寸列表（Get-PrinterProperty PaperSize 可后续扩展）')

      // 分辨率
      const dpi = row.HorizontalResolution ?? row.VerticalResolution ?? null
      report.maxResolutionDpi = dpi && dpi > 0 ? supportedCap(dpi, 'SYSTEM', `Win32_Printer Resolution=${dpi}`) : unknownCap('SYSTEM', '无分辨率字段')

      // 速度：WMI 无 ppm 标准字段 → UNKNOWN（严禁猜测）
      report.ppm = unknownCap('SYSTEM', 'WMI 无打印速度字段')

      // ⚠️ 墨量：WMI 无标准字段 → consumables unknown（严禁猜测）
      report.consumables = unknownCap('SYSTEM', 'WMI 无标准墨量字段（需厂商 API/SNMP 才可探测）')

      report.probes.push(okProbe('SYSTEM', Date.now() - startedAt))
      return report
    } catch (err) {
      report.probes.push(failProbe('SYSTEM', Date.now() - startedAt, `Win32_Printer 响应解析失败：${err instanceof Error ? err.message : String(err)}`))
      return report
    }
  }

  async getStatus(key: string): Promise<{ status: PrinterStatus; message: string }> {
    if (!(await this.available())) throw new Error('Windows 后端在当前平台不可用')
    // WorkOffline + PrinterStatus（Win32_Printer.PrinterStatus: 3=Idle 4=Printing 5=Warmup 7=Offline…）
    const script = `Get-CimInstance Win32_Printer -Filter "Name='${key.replace(/'/g, "''")}'" | Select-Object Name,PrinterStatus,WorkOffline,Local | ConvertTo-Json -Compress`
    const res = await powershell(script)
    if (!res.ok || !res.stdout.trim()) throw new Error(`Win32_Printer 状态查询失败：${res.stderr.trim()}`)
    const row = toRows<{ Name: string; PrinterStatus?: number; WorkOffline?: boolean }>(res.stdout.trim())[0]!
    if (row.WorkOffline) return { status: 'offline', message: 'Windows 报告 WorkOffline=true' }
    switch (row.PrinterStatus) {
      case 3:
        return { status: 'online', message: 'Win32_Printer PrinterStatus=3 (Idle)' }
      case 4:
        return { status: 'busy', message: 'Win32_Printer PrinterStatus=4 (Printing)' }
      case 5:
        return { status: 'busy', message: 'Win32_Printer PrinterStatus=5 (Warmup)' }
      case 7:
        return { status: 'offline', message: 'Win32_Printer PrinterStatus=7 (Offline)' }
      case 6:
        return { status: 'paper-out', message: 'Win32_Printer PrinterStatus=6 (Paper Out)' }
      default:
        return { status: 'error', message: `Win32_Printer PrinterStatus=${row.PrinterStatus ?? '未知'}` }
    }
  }

  async submitJob(req: SubmitJobRequest): Promise<{ jobId: string }> {
    if (!(await this.available())) throw new Error('Windows 后端在当前平台不可用')
    // PDF → Start-Process -Verb PrintTo（依赖系统默认 PDF 关联应用，如 Edge；免驱打印 PDF 的标准做法）
    // 注：份数/双面等选项经由打印对话框或驱动默认设置（Verb PrintTo 不接受选项参数 —— 已注明此限制）
    // PDF 字节通过 base64 内嵌到 PowerShell 脚本（跨进程传二进制最可靠的方式）
    const b64 = Buffer.from(req.pdf).toString('base64')
    const psScript = [
      `$ErrorActionPreference='Stop'`,
      `$tmp=Join-Path $env:TEMP "ops-${Date.now()}-${Math.floor(Math.random() * 1e6)}.pdf"`,
      `[System.IO.File]::WriteAllBytes($tmp, [System.Convert]::FromBase64String('${b64}'))`,
      `try { Start-Process -FilePath $tmp -Verb PrintTo '${req.printerKey.replace(/'/g, "''")}' -PassThru | Select-Object Id | ConvertTo-Json -Compress } finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }`,
    ].join('; ')
    const res = await powershell(psScript, 30_000)
    if (!res.ok) throw new Error(`Start-Process -Verb PrintTo 失败：${res.stderr.trim() || res.stdout.trim()}`)
    let jobId = `win-${Date.now()}`
    try {
      const parsed = JSON.parse(res.stdout.trim()) as { Id?: number } | null
      if (parsed?.Id) jobId = `win-${parsed.Id}`
    } catch {
      /* PassThru 输出缺失时用时间戳兜底 */
    }
    return { jobId }
  }

  async getJobStatus(_key: string, jobId: string): Promise<BackendJobStatus> {
    if (!(await this.available())) return { state: 'unknown', progress: 0, message: 'Windows 后端在当前平台不可用' }
    const numeric = Number(jobId.replace(/^win-/, ''))
    if (!Number.isInteger(numeric)) return { state: 'unknown', progress: 0, message: `非 Windows 任务 id：${jobId}` }
    const script = `Get-PrintJob -PrinterName '${_key.replace(/'/g, "''")}' | Where-Object { $_.Id -eq ${numeric} } | Select-Object Id,DocumentName,JobStatus,TotalPages,PrintedPages | ConvertTo-Json -Compress`
    const res = await powershell(script)
    if (!res.ok) return { state: 'unknown', progress: 0, message: `Get-PrintJob 失败：${res.stderr.trim()}` }
    if (!res.stdout.trim() || res.stdout.trim() === '') {
      // 队列中已无该任务 → Windows 打印完成后任务即出队，视为 completed
      return { state: 'completed', progress: 100, message: '任务已离开打印队列（Get-PrintJob 无记录）' }
    }
    try {
      const row = toRows<WinPrintJobRow>(res.stdout.trim())[0]!
      const state = mapWinJobStatus(row.JobStatus)
      const total = row.TotalPages ?? null
      const printed = row.PrintedPages ?? null
      const progress = total && total > 0 && printed !== null ? Math.min(100, Math.round((printed / total) * 100)) : state === 'completed' ? 100 : 0
      return { state, progress, sheetsDone: printed ?? undefined, message: `Get-PrintJob JobStatus=${Array.isArray(row.JobStatus) ? row.JobStatus.join(',') : row.JobStatus}` }
    } catch (err) {
      return { state: 'unknown', progress: 0, message: `Get-PrintJob 响应解析失败：${err instanceof Error ? err.message : String(err)}` }
    }
  }

  async cancelJob(key: string, jobId: string): Promise<{ ok: boolean; message?: string }> {
    if (!(await this.available())) return { ok: false, message: 'Windows 后端在当前平台不可用' }
    const numeric = Number(jobId.replace(/^win-/, ''))
    if (!Number.isInteger(numeric)) return { ok: false, message: `非 Windows 任务 id：${jobId}` }
    const script = `Remove-PrintJob -InputObject (Get-PrintJob -PrinterName '${key.replace(/'/g, "''")}' | Where-Object Id -eq ${numeric})`
    const res = await powershell(script)
    if (res.ok) return { ok: true, message: `Remove-PrintJob 已执行（job ${jobId}）` }
    // 任务已出队（打印完成）→ 取消幂等
    if (/cannot bind|null/i.test(res.stderr)) return { ok: true, message: `任务 ${jobId} 已离开队列（取消幂等）` }
    return { ok: false, message: `Remove-PrintJob 失败：${res.stderr.trim()}` }
  }

  private unavailableReport(): CapabilityReport {
    const report = emptyReport('SYSTEM', 'Windows 后端在当前平台不可用（需 win32）')
    report.probes.push(failProbe('SYSTEM', 0, 'platform !== win32'))
    return report
  }
}

/** 文本测试页打印（Out-Printer；供后续调试用） */
export async function printTextTestPage(printerName: string, text: string): Promise<boolean> {
  if (process.platform !== 'win32') return false
  const res = await powershell(`Out-Printer -Name '${printerName.replace(/'/g, "''")}' -InputObject '${text.replace(/'/g, "''")}'`)
  return res.ok
}

/** 导出供类型推导（ConsumableInfo 用于 getCapabilities 文档化） */
export type WindowsConsumableInfo = ConsumableInfo
