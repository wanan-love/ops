import type { BackendKind, CapabilityReport, PrintOptions, Printer, PrinterStatus } from '../core/types'
import type { JobManager } from '../core/jobs'
import type { PrinterRegistry } from '../core/printers'
import type { VirtualPrintEngine } from '../core/engine'
import { emptyReport, okProbe, supportedCap } from './merge'

/**
 * PrinterBackend — 打印后端统一接口（可插拔，七方法）。
 *
 *  - mock   ：Virtual Printer 模拟引擎（MVP，始终可用）
 *  - ipp    ：IPP 协议直连（自研 RFC 8010/8011 协议栈；本环境对接 Virtual IPP Server :3061）
 *  - cups   ：系统 CUPS（lpstat/lp + ipp://localhost:631；macOS/Linux 桌面）
 *  - windows：Win32 打印栈（PowerShell；需 Windows 宿主）
 *
 * Core（协议/队列/UI）不感知后端差异；平台相关代码全部收敛在 backends/ 目录。
 *
 * 契约定（调用方依赖）：
 *  - available()：环境可用性探测（如 Linux 上 CUPS 不可用）
 *  - getCapabilities()：绝不抛异常 —— 失败返回全 unknown 报告 + 失败 probe（三态红线）
 *  - getStatus()：探测失败抛异常（由状态同步循环计数处理）
 *  - submitJob()：失败抛异常（由 BackendJobRunner 将任务置为 failed）
 *  - getJobStatus()：轮询容错 —— 失败返回 state='unknown'，绝不抛异常炸队列
 *  - cancelJob()：返回 {ok, message}，不抛异常
 */

/** 后端内的打印机引用（listPrinters / import 的数据源） */
export interface BackendPrinterRef {
  /** 后端内打印机标识（vipp id / CUPS queue 名 / 手动添加的 URI） */
  key: string
  displayName: string
  description?: string
  location?: string
  uri?: string
  makeAndModel?: string
}

/** 后端任务提交请求 */
export interface SubmitJobRequest {
  printerKey: string
  pdf: Uint8Array
  fileName: string
  options: PrintOptions
  userName: string
  jobName: string
}

/** 后端任务状态（轮询结果；state='unknown' = 暂时读取不到） */
export interface BackendJobStatus {
  state: 'pending' | 'processing' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'unknown'
  progress: number
  message?: string
  sheetsDone?: number
}

export interface PrinterBackend {
  kind: BackendKind
  /** 不可用时的解释（显示在 Host 控制台 /api/backends） */
  readonly availabilityNote: string
  available(): Promise<boolean>
  listPrinters(): Promise<BackendPrinterRef[]>
  getPrinter(key: string): Promise<BackendPrinterRef | null>
  getCapabilities(key: string): Promise<CapabilityReport>
  getStatus(key: string): Promise<{ status: PrinterStatus; message: string }>
  submitJob(req: SubmitJobRequest): Promise<{ jobId: string; jobUri?: string }>
  getJobStatus(key: string, jobId: string): Promise<BackendJobStatus>
  cancelJob(key: string, jobId: string): Promise<{ ok: boolean; message?: string }>
}

// ---------------------------------------------------------------- MockPrinterBackend（适配层）

/**
 * MockPrinterBackend — Virtual Printer 后端适配器。
 *
 * 虚拟打印机能力是「定义出来的」（SYSTEM 来源，确定 supported）；
 * 任务提交路径保持现状：现有 REST/selftest 场景仍直接走 jobs.submit + VirtualPrintEngine 引擎推进，
 * 本适配器仅提供统一七接口实现（供 /api/backends/:kind/printers 等通用端点使用）。
 */
export class MockPrinterBackend implements PrinterBackend {
  readonly kind: BackendKind = 'mock'
  readonly availabilityNote = 'Virtual Printer 模拟后端：接收 PDF 并模拟完整打印流程（FIFO/ppm 推进/条件注入/墨耗），无需物理设备，始终可用'

  constructor(
    private readonly printers: PrinterRegistry,
    private readonly jobs: JobManager,
    private readonly engine: VirtualPrintEngine,
  ) {}

  async available(): Promise<boolean> {
    return true
  }

  async listPrinters(): Promise<BackendPrinterRef[]> {
    return this.printers
      .listAll()
      .filter((p) => p.backend === 'mock')
      .map((p) => ({
        key: p.id,
        displayName: p.name,
        description: p.description,
        location: p.location,
        uri: `ops-virtual://${p.id}`,
        makeAndModel: 'OpenPrintShare Virtual Printer',
      }))
  }

  async getPrinter(key: string): Promise<BackendPrinterRef | null> {
    const refs = await this.listPrinters()
    return refs.find((r) => r.key === key) ?? null
  }

  async getCapabilities(key: string): Promise<CapabilityReport> {
    const printer = this.printers.get(key)
    if (!printer || printer.backend !== 'mock') {
      const report = emptyReport('SYSTEM', `虚拟打印机 ${key} 不存在`)
      return report
    }
    return mockCapabilityReport(printer)
  }

  async getStatus(key: string): Promise<{ status: PrinterStatus; message: string }> {
    const printer = this.printers.get(key)
    if (!printer) throw new Error(`虚拟打印机 ${key} 不存在`)
    return { status: printer.status, message: printer.statusMessage || `虚拟打印机状态：${printer.status}` }
  }

  async submitJob(req: SubmitJobRequest): Promise<{ jobId: string }> {
    const printer = this.printers.get(req.printerKey)
    if (!printer || printer.backend !== 'mock') throw new Error(`虚拟打印机 ${req.printerKey} 不存在`)
    const job = await this.jobs.submit({
      printer,
      pdf: req.pdf,
      fileName: req.fileName,
      options: req.options,
      source: { deviceId: 'ops-backend-mock', deviceName: req.userName || 'OPS Backend', platform: 'web' },
    })
    return { jobId: job.id }
  }

  async getJobStatus(_key: string, jobId: string): Promise<BackendJobStatus> {
    const job = this.jobs.get(jobId)
    if (!job) return { state: 'unknown', progress: 0, message: `任务不存在：${jobId}` }
    const message = job.error ?? (job.state === 'processing' ? `正在打印 ${job.fileName}` : undefined)
    return { state: job.state, progress: job.progress, sheetsDone: job.printedSheets, message }
  }

  async cancelJob(_key: string, jobId: string): Promise<{ ok: boolean; message?: string }> {
    const job = this.jobs.get(jobId)
    if (!job) return { ok: false, message: `任务不存在：${jobId}` }
    return this.engine.cancelJob(job)
  }
}

/** 虚拟打印机实体 → 能力报告（SYSTEM 来源：定义出来的能力，确定） */
export function mockCapabilityReport(printer: Printer): CapabilityReport {
  const caps = printer.capabilities
  return {
    color: supportedCap(caps.color, 'SYSTEM', '虚拟打印机定义能力'),
    duplex: supportedCap(caps.duplex, 'SYSTEM', '虚拟打印机定义能力'),
    maxCopies: supportedCap(caps.maxCopies, 'SYSTEM', '虚拟打印机定义能力'),
    paperSizes: supportedCap(caps.paperSizes, 'SYSTEM', '虚拟打印机定义能力'),
    maxResolutionDpi: supportedCap(caps.maxResolutionDpi, 'SYSTEM', '虚拟打印机定义能力'),
    ppm: supportedCap(caps.ppm, 'SYSTEM', '虚拟打印机定义能力'),
    consumables: supportedCap(
      [
        { name: 'Cyan 墨水（虚拟）', kind: 'ink' as const, color: '#00FFFF', levelPct: printer.ink.cyan, source: 'SYSTEM' as const },
        { name: 'Magenta 墨水（虚拟）', kind: 'ink' as const, color: '#FF00FF', levelPct: printer.ink.magenta, source: 'SYSTEM' as const },
        { name: 'Yellow 墨水（虚拟）', kind: 'ink' as const, color: '#FFFF00', levelPct: printer.ink.yellow, source: 'SYSTEM' as const },
        { name: 'Black 墨水（虚拟）', kind: 'ink' as const, color: '#000000', levelPct: printer.ink.black, source: 'SYSTEM' as const },
      ],
      'SYSTEM',
      '虚拟打印机 CMYK 墨量（引擎实时模拟）',
    ),
    probes: [okProbe('SYSTEM', 0)],
  }
}

// ---------------------------------------------------------------- BackendManager

export interface BackendAvailability {
  kind: BackendKind
  available: boolean
  note: string
}

/** 后端注册表：kind → 实例（依赖注入装配于 host.ts） */
export class BackendManager {
  private readonly map = new Map<BackendKind, PrinterBackend>()
  private availCache: BackendAvailability[] | null = null

  constructor(backends: PrinterBackend[]) {
    for (const backend of backends) this.map.set(backend.kind, backend)
  }

  get(kind: BackendKind): PrinterBackend | undefined {
    return this.map.get(kind)
  }

  list(): PrinterBackend[] {
    return [...this.map.values()]
  }

  kinds(): BackendKind[] {
    return [...this.map.keys()]
  }

  /** 全量探测可用性（带缓存；force=true 强制重探） */
  async availability(force = false): Promise<BackendAvailability[]> {
    if (this.availCache && !force) return this.availCache
    const results = await Promise.all(
      this.list().map(async (b) => {
        let available = false
        try {
          available = await b.available()
        } catch {
          available = false
        }
        return { kind: b.kind, available, note: b.availabilityNote }
      }),
    )
    this.availCache = results
    return results
  }

  /** 最近一次探测的缓存（未探测时返回 null） */
  cachedAvailability(): BackendAvailability[] | null {
    return this.availCache
  }

  /** 主后端：可用后端里优先 ipp/cups/windows，否则 mock（HostInfo.backend 兼容字段） */
  primaryBackend(avail: BackendAvailability[]): BackendKind {
    for (const kind of ['ipp', 'cups', 'windows'] as BackendKind[]) {
      if (avail.some((a) => a.kind === kind && a.available)) return kind
    }
    return 'mock'
  }

  invalidateCache(): void {
    this.availCache = null
  }
}
