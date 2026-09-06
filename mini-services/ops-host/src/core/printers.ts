import { randomUUID } from 'node:crypto'
import type { Printer, PrinterCapabilities, PrinterStatus } from './types'
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
    } else {
      this.seed()
      await this.persistNow()
    }
  }

  /** MVP 种子：三台 Virtual Printer（两台已共享 + 一台未共享，演示共享开关） */
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
