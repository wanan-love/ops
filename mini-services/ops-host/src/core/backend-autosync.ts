import type { PrinterRegistry } from './printers'
import type { BackendManager } from '../backends/index'
import type { EventBus } from './eventbus'
import type { EventLog } from './eventlog'
import type { BackendKind } from './types'

/**
 * BackendAutoSync — 系统真实打印机自动发现与同步（真实性红线模块）。
 *
 * 职责：在 Windows / macOS / Linux 宿主上，把「系统打印栈里真实安装的打印机」
 * 自动导入 OPS 注册表（幂等去重 + 能力探测 + 系统默认标记同步）。
 *
 * 原则：
 *  - 只同步系统后端（windows / cups）——mock/vipp 属开发模式，ipp 直连由用户手动/mDNS 导入；
 *  - 后端 available() = false 时静默跳过（如实不可用，不伪造）；
 *  - importFromBackend 幂等去重：同一台设备只保留一个条目，用户改过的「共享」选择不被覆盖；
 *  - 枚举消失的打印机不自动删除（保留统计/任务历史），仅记录事件日志——删除是显式用户动作；
 *  - 每次同步以「本次枚举的实际值」刷新 isSystemDefault（系统默认打印机换了，标记跟着换）。
 */
export interface BackendAutoSyncOptions {
  printers: PrinterRegistry
  backends: BackendManager
  bus: EventBus
  log: EventLog
  /** 同步周期（默认 60s；启动时立即执行一次） */
  intervalMs?: number
  /** 参与自动同步的系统后端（默认 windows + cups） */
  kinds?: BackendKind[]
}

export interface AutoSyncResult {
  kind: BackendKind
  available: boolean
  imported: number
  updated: number
  vanished: string[]
  error?: string
}

export class BackendAutoSync {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  private readonly intervalMs: number
  private readonly kinds: BackendKind[]
  /** 已注册的 printer id（按 kind 分组——用于消失检测） */
  private lastSeenIds = new Map<BackendKind, Set<string>>()

  constructor(private readonly opts: BackendAutoSyncOptions) {
    this.intervalMs = opts.intervalMs ?? 60_000
    this.kinds = opts.kinds ?? ['windows', 'cups']
  }

  start(): void {
    if (this.timer) return
    // 启动即同步一次（延迟 1.5s 让后端可用性探测先完成）
    setTimeout(() => {
      void this.syncOnce()
    }, 1500)
    this.timer = setInterval(() => {
      void this.syncOnce()
    }, this.intervalMs)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** 单次同步（并发保护：上次未完成则跳过本轮） */
  async syncOnce(): Promise<AutoSyncResult[]> {
    if (this.running) return []
    this.running = true
    try {
      const results = await Promise.all(this.kinds.map((kind) => this.syncKind(kind)))
      const changed = results.some((r) => r.imported > 0 || r.vanished.length > 0)
      if (changed) this.opts.bus.emit('snapshot', {})
      return results
    } finally {
      this.running = false
    }
  }

  private async syncKind(kind: BackendKind): Promise<AutoSyncResult> {
    const result: AutoSyncResult = { kind, available: false, imported: 0, updated: 0, vanished: [] }
    const backend = this.opts.backends.get(kind)
    if (!backend) {
      result.error = `后端未装配：${kind}`
      return result
    }
    try {
      result.available = await backend.available()
      if (!result.available) return result
      const refs = await backend.listPrinters()
      const seen = new Set<string>()
      for (const ref of refs) {
        seen.add(ref.key)
        const existing = this.opts.printers.findExisting(kind, ref)
        if (existing) {
          // 幂等更新：能力刷新 + 系统默认标记刷新（保留用户 shared 选择——不传 opts.shared）
          await this.opts.printers.importFromBackend(backend, ref)
          result.updated++
        } else {
          await this.opts.printers.importFromBackend(backend, ref)
          result.imported++
          this.opts.log.host(`系统打印机自动发现：从 ${kind} 后端导入「${ref.displayName}」${ref.isDefault === true ? '（系统默认）' : ''}`)
        }
      }
      // 消失检测：上轮在册、本轮枚举不存在的系统打印机 → 记录事件（不删除，保守策略）
      const prev = this.lastSeenIds.get(kind)
      if (prev) {
        for (const key of prev) {
          if (!seen.has(key)) {
            result.vanished.push(key)
            this.opts.log.host(`系统打印机已从 ${kind} 枚举中消失：${key}（条目保留，状态交由状态同步探测）`)
          }
        }
      }
      this.lastSeenIds.set(kind, seen)
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err)
    }
    return result
  }
}
