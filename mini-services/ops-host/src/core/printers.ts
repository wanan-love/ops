import { randomUUID } from 'node:crypto'
import type { Printer, PrinterCapabilities, PrinterStatus, PrintOptions, BackendKind } from './types'
import type { CapabilityReport, CapabilitySource } from './types'
import type { BackendPrinterRef, PrinterBackend } from '../backends/index'
import { mergeReports, resolveEffectiveCaps } from '../backends/merge'
import type { FileStorage } from './storage'
import type { EventBus } from './eventbus'
import type { EventLog } from './eventlog'

const REL = 'printers.json'

export interface CreatePrinterInput {
  name: string
  description?: string
  location?: string
  shared?: boolean
  test?: boolean
  capabilities?: Partial<PrinterCapabilities>
}

export interface ImportFromBackendOptions {
  shared?: boolean
  displayName?: string
  /** Self-Test 场景导入的隔离打印机（clear-test-data 清理） */
  test?: boolean
  /** 保留既有 isSystemDefault（默认 false：以本次枚举的实际值为准） */
  keepSystemDefault?: boolean
}

/** 后端 kind → 能力报告默认来源 */
const BACKEND_SOURCE: Record<string, CapabilitySource> = {
  ipp: 'IPP',
  cups: 'CUPS',
  windows: 'SYSTEM',
  mock: 'SYSTEM',
}

function nowIso(): string {
  return new Date().toISOString()
}

function shortId(): string {
  return randomUUID().slice(0, 8)
}

function fullInk(): { cyan: number; magenta: number; yellow: number; black: number } {
  return { cyan: 100, magenta: 100, yellow: 100, black: 100 }
}

/**
 * 打印机注册表：管理 Printer 实体（虚拟打印机即 MockPrinterBackend 的设备）。
 * 状态流转副作用由 VirtualPrintEngine 注入执行，注册表本身只负责数据与持久化。
 */
export class PrinterRegistry {
  private printers = new Map<string, Printer>()
  private dirty = false
  private lastPersistAt = 0

  constructor(
    private readonly storage: FileStorage,
    private readonly bus: EventBus,
    private readonly log: EventLog,
  ) {}

  async load(): Promise<void> {
    const stored = await this.storage.readJson<Printer[]>(REL, [])
    if (stored.length > 0) {
      this.printers = new Map(stored.map((p) => [p.id, p]))
    }
    // 种子虚拟打印机仅开发模式创建（OPS_DEV_MODE=1；正式运行环境不创建/不显示任何虚拟打印机）
  }

  /** 开发模式 MVP 种子：三台 Virtual Printer（两台已共享 + 一台未共享，演示共享开关）。
   *  仅 loadFromDevMode() 调用 —— host.ts 在 OPS_DEV_MODE=1 且无既有数据时执行；正式运行永不触达。 */
  loadFromDevMode(): void {
    if (this.printers.size > 0) return
    this.seed()
    void this.persistNow()
  }

  /** MVP 种子：三台 Virtual Printer（MockPrinterBackend 设备档案；仅开发/测试模式） */
  private seed(): void {
    const mk = (id: string, name: string, description: string, location: string, caps: Partial<PrinterCapabilities>, shared: boolean): Printer => ({
      id,
      name,
      description,
      location,
      backend: 'mock',
      virtual: true,
      shared,
      status: 'online',
      statusMessage: '',
      ink: fullInk(),
      capabilities: {
        color: true,
        duplex: 'both',
        maxCopies: 99,
        paperSizes: ['A4', 'Letter', 'A5'],
        maxResolutionDpi: 1200,
        ppm: 12,
        ...caps,
      },
      defaultOptions: {
        paperSize: (caps.paperSizes ?? ['A4'])[0],
        colorMode: caps.color === false ? 'monochrome' : 'color',
        duplex: caps.duplex === 'none' ? 'none' : 'long-edge',
        copies: 1,
        quality: 'normal',
      },
      speedOverridePpm: null,
      stats: { submitted: 0, completed: 0, failed: 0, cancelled: 0, sheets: 0 },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })

    this.printers.set(
      'vp-color-laser',
      mk('vp-color-laser', 'OPS Virtual Color Laser', '虚拟彩色激光打印机（MockPrinterBackend · Virtual Printer）', '演示机房 A-01', { color: true, duplex: 'both', ppm: 12 }, true),
    )
    this.printers.set(
      'vp-mono-inkjet',
      mk('vp-mono-inkjet', 'OPS Virtual Mono Inkjet', '虚拟单色喷墨打印机（不支持彩色与双面）', '演示机房 A-02', { color: false, duplex: 'none', ppm: 6, paperSizes: ['A4', 'Letter'] }, true),
    )
    this.printers.set(
      'vp-receipt',
      mk('vp-receipt', 'OPS Virtual Receipt', '默认未共享 —— 用于演示「共享 / 取消共享」流程', '演示机房 B-01', { color: false, duplex: 'none', ppm: 8, paperSizes: ['A4'] }, false),
    )
  }

  listAll(): Printer[] {
    return [...this.printers.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  listShared(): Printer[] {
    return this.listAll().filter((p) => p.shared)
  }

  get(id: string): Printer | undefined {
    return this.printers.get(id)
  }

  create(input: CreatePrinterInput): Printer {
    const id = `vp-${shortId()}`
    const caps: PrinterCapabilities = {
      color: input.capabilities?.color ?? true,
      duplex: input.capabilities?.duplex ?? 'both',
      maxCopies: input.capabilities?.maxCopies ?? 99,
      paperSizes: input.capabilities?.paperSizes ?? ['A4', 'Letter'],
      maxResolutionDpi: input.capabilities?.maxResolutionDpi ?? 600,
      ppm: input.capabilities?.ppm ?? 10,
    }
    const printer: Printer = {
      id,
      name: input.name,
      description: input.description ?? '虚拟打印机（用户创建）',
      location: input.location ?? '',
      backend: 'mock',
      virtual: true,
      shared: input.shared ?? true,
      status: 'online',
      statusMessage: '',
      ink: fullInk(),
      capabilities: caps,
      defaultOptions: {
        paperSize: caps.paperSizes[0],
        colorMode: caps.color ? 'color' : 'monochrome',
        duplex: caps.duplex === 'none' ? 'none' : 'long-edge',
        copies: 1,
        quality: 'normal',
      },
      speedOverridePpm: null,
      stats: { submitted: 0, completed: 0, failed: 0, cancelled: 0, sheets: 0 },
      test: input.test ?? false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    this.printers.set(id, printer)
    void this.persistNow()
    this.bus.emit('printer:update', { printer })
    this.log.printer(printer, `打印机已创建：${printer.name}`)
    return printer
  }

  patch(id: string, patch: Partial<Pick<Printer, 'name' | 'description' | 'location' | 'shared' | 'defaultOptions'>>): Printer | undefined {
    const printer = this.printers.get(id)
    if (!printer) return undefined
    Object.assign(printer, patch)
    printer.updatedAt = nowIso()
    void this.persistNow()
    this.bus.emit('printer:update', { printer })
    if (patch.shared !== undefined) {
      this.log.printer(printer, patch.shared ? `已共享打印机：${printer.name}` : `已取消共享：${printer.name}`)
    } else {
      this.log.printer(printer, `打印机已更新：${printer.name}`)
    }
    return printer
  }

  /** 引擎直接修改状态/墨量等运行时字段后调用 */
  touch(printer: Printer, opts?: { persist?: boolean; emit?: boolean }): void {
    printer.updatedAt = nowIso()
    if (opts?.emit !== false) this.bus.emit('printer:update', { printer })
    if (opts?.persist) {
      this.dirty = true
      void this.persistNow()
    } else {
      this.dirty = true
    }
  }

  // ------------------------------------------------------- 真实后端导入与能力刷新

  /**
   * 按后端引用查找既有条目：先 key 推导 id，再 URI 归一化去重（同一设备可经多路径导入）。
   * 供 importFromBackend 复用；自测自动清理也用它做导入前快照。
   */
  findExisting(kind: BackendKind, ref: BackendPrinterRef): Printer | undefined {
    const id = `${kind}-${sanitizeKey(ref.key)}`
    const byId = this.printers.get(id)
    if (byId) return byId
    if (ref.uri) {
      const target = normalizePrinterUri(ref.uri)
      return this.listAll().find(
        (p) => p.backend === kind && p.backendUri && normalizePrinterUri(p.backendUri) === target,
      )
    }
    return undefined
  }

  /**
   * 从后端导入打印机（幂等去重）：
   *  1. 同 backend+backendKey → 复用既有条目（刷新能力）
   *  2. 同 backend 且 backendUri 归一化相同 → 视为同一台物理设备，复用既有条目
   *     （解决「后端列表导入（key=vipp-full）」与「mDNS 发现/手动 URI 添加（key=完整 URI）」双路径重复）
   * 创建/更新 Printer 实体（backend/backendKey/backendUri/virtual=false）→ 立即 getCapabilities
   * → 存 capabilityReport + resolveEffectiveCaps → capabilities → 落盘。
   */
  async importFromBackend(backend: PrinterBackend, ref: BackendPrinterRef, opts?: ImportFromBackendOptions): Promise<Printer> {
    const kind = backend.kind
    // 真实能力探测（失败也不阻塞导入 —— 全 unknown 报告 + 失败 probe）
    const report = await backend.getCapabilities(ref.key)
    const caps = resolveEffectiveCaps(report)
    const defaultOptions: PrintOptions = {
      paperSize: caps.paperSizes[0] ?? 'A4',
      colorMode: caps.color ? 'color' : 'monochrome',
      duplex: caps.duplex === 'none' ? 'none' : 'long-edge',
      copies: 1,
      quality: 'normal',
    }
    let printer = this.findExisting(kind, ref)
    let deduped = printer !== undefined && printer.id !== `${kind}-${sanitizeKey(ref.key)}`
    if (!printer) {
      const id = `${kind}-${sanitizeKey(ref.key)}`
      printer = {
        id,
        name: opts?.displayName ?? ref.displayName,
        description: ref.description ?? `从 ${kind} 后端导入的打印机`,
        location: ref.location ?? '',
        backend: kind,
        virtual: false,
        shared: opts?.shared ?? true,
        status: 'online',
        statusMessage: '',
        ink: fullInk(),
        capabilities: caps,
        defaultOptions,
        speedOverridePpm: null,
        stats: { submitted: 0, completed: 0, failed: 0, cancelled: 0, sheets: 0 },
        test: opts?.test ?? false,
        backendKey: ref.key,
        backendUri: ref.uri,
        capabilityReport: report,
        // 系统默认打印机标记（Windows Win32_Printer.Default / CUPS lpstat -d；读取不到 = undefined 不猜测）
        isSystemDefault: ref.isDefault === true ? true : undefined,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }
      this.printers.set(id, printer)
      this.log.printer(printer, `已从 ${kind} 后端导入打印机：${printer.name}（${ref.uri ?? ref.key}${ref.isDefault === true ? ' · 系统默认' : ''}）`)
    } else {
      // 幂等更新：字段保留 / 能力刷新 / 系统默认标记以本次枚举实际值为准（undefined = 读取不到，保留旧值）
      printer.backendKey = ref.key
      printer.backendUri = ref.uri
      printer.capabilityReport = report
      printer.capabilities = caps
      printer.defaultOptions = defaultOptions
      if (opts?.displayName) printer.name = opts.displayName
      if (ref.description) printer.description = ref.description
      if (ref.location !== undefined) printer.location = ref.location
      if (opts?.shared !== undefined) printer.shared = opts.shared
      if (opts?.test !== undefined) printer.test = opts.test
      if (!opts?.keepSystemDefault) {
        if (ref.isDefault !== undefined) printer.isSystemDefault = ref.isDefault === true ? true : undefined
        else if (printer.isSystemDefault) printer.isSystemDefault = undefined
      }
      printer.updatedAt = nowIso()
      this.log.printer(
        printer,
        deduped
          ? `去重合并：${ref.uri ?? ref.key} 与既有条目指向同一设备，已复用「${printer.name}」并刷新能力`
          : `已刷新后端打印机导入信息：${printer.name}（${ref.uri ?? ref.key}）`,
      )
    }
    await this.persistNow()
    this.bus.emit('printer:update', { printer })
    return printer
  }

  /**
   * 刷新能力（并行探测：后端属性 + SNMP 耗材等额外来源 → merge）。
   * 失败仅记录 probe，不覆盖已有已知数据（旧报告作为兑底输入参与合并 —— 保留上次成功值 + 原时间戳）。
   */
  async refreshCapabilities(
    printer: Printer,
    backend: PrinterBackend | null,
    extras?: Promise<Array<{ source: CapabilitySource; report: CapabilityReport }>>,
  ): Promise<CapabilityReport> {
    const source = BACKEND_SOURCE[printer.backend] ?? 'UNKNOWN'
    const inputs: Array<{ source: CapabilitySource; report: CapabilityReport }> = []
    const [backendReport, extraList] = await Promise.all([
      backend && printer.backendKey
        ? backend.getCapabilities(printer.backendKey)
        : Promise.resolve(null),
      extras ?? Promise.resolve([] as Array<{ source: CapabilitySource; report: CapabilityReport }>),
    ])
    if (backendReport) inputs.push({ source, report: backendReport })
    for (const extra of extraList) inputs.push(extra)
    // 旧报告（去除 probes）作为兑底：新探测 unknown 时保留上次成功值
    if (printer.capabilityReport) {
      const prev = printer.capabilityReport
      inputs.push({ source: 'UNKNOWN', report: { ...prev, probes: [] } })
    }
    const merged = mergeReports(inputs)
    // probes 补齐：本次后端探测若成功但未带 probe（不会发生，IPP/CUPS/SYSTEM 都带）—— 保守处理
    printer.capabilityReport = merged
    printer.capabilities = resolveEffectiveCaps(merged)
    printer.updatedAt = nowIso()
    await this.persistNow()
    this.bus.emit('printer:update', { printer })
    this.log.printer(printer, `能力已刷新（${merged.probes.length} 条探测记录，color=${merged.color.state}，duplex=${merged.duplex.state}，耗材=${merged.consumables.state}）`)
    return merged
  }

  setStatus(printer: Printer, status: PrinterStatus, message: string): void {
    printer.status = status
    printer.statusMessage = message
    this.touch(printer, { persist: true })
    this.log.printer(printer, message || `打印机状态 → ${status}`)
  }

  remove(id: string): Printer | undefined {
    const printer = this.printers.get(id)
    if (!printer) return undefined
    this.printers.delete(id)
    void this.storage.writeJson(REL, this.listAll())
    this.log.printer(printer, `打印机已删除：${printer.name}`)
    return printer
  }

  /** 节流持久化（引擎每 tick 消耗墨量，避免高频写盘） */
  persistThrottled(minIntervalMs = 4000): void {
    if (!this.dirty) return
    const now = Date.now()
    if (now - this.lastPersistAt < minIntervalMs) return
    this.dirty = false
    this.lastPersistAt = now
    void this.persistNow()
  }

  async persistNow(): Promise<void> {
    this.dirty = false
    this.lastPersistAt = Date.now()
    await this.storage.writeJson(REL, this.listAll())
  }
}

/** 导入 id 的 key 清洗（URI / queue 名 → 合法 id 片段） */
function sanitizeKey(key: string): string {
  const cleaned = key
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
  return cleaned === '' ? randomUUID().slice(0, 8) : cleaned
}

/**
 * URI 归一化（去重用）：小写 scheme/host、回环别名归一为 127.0.0.1、去尾斜杠。
 * 例：ipp://LocalHost:3061/printers/x/ 与 ipp://127.0.0.1:3061/printers/x → 同一。
 * 远端主机不同名称/地址不做合并（无法离线判定为同一设备，保守策略）。
 */
export function normalizePrinterUri(uri: string): string {
  const m = /^([a-z]+):\/\/([^\/:?#]+)(?::(\d+))?(\/.*)?$/i.exec(uri.trim())
  if (!m) return uri.trim().toLowerCase().replace(/\/+$/, '')
  const scheme = m[1].toLowerCase()
  const host = m[2].toLowerCase()
  const port = m[3]
  const rest = m[4] ?? ''
  const isLoopback = host === 'localhost' || host === '::1' || /^0*127(\.\d{1,3}){3}$/.test(host) || host === '0.0.0.0'
  const canonicalHost = isLoopback ? '127.0.0.1' : host
  const isDefaultPort = (scheme === 'ipp' || scheme === 'ipps') && port === '631'
  const portPart = port && !isDefaultPort ? `:${port}` : ''
  const path = rest.replace(/\/+$/, '')
  return `${scheme}://${canonicalHost}${portPart}${path}`
}
