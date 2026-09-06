import { randomUUID } from 'node:crypto'
import type { OpsEvent, Printer, PrintJob, TestRun } from './types'
import type { FileStorage } from './storage'
import type { EventBus } from './eventbus'

type EventInput = Omit<OpsEvent, 'id' | 'at'>

/**
 * 全局事件日志：内存环形缓冲（供 API 快速查询）+ events.jsonl 追加（持久化），
 * 并通过 EventBus 以 'event' 广播给 WS 客户端。
 */
export class EventLog {
  private ring: OpsEvent[] = []
  private readonly capacity = 400

  constructor(
    private readonly storage: FileStorage,
    private readonly bus: EventBus,
  ) {}

  async load(): Promise<void> {
    const history = await this.storage.readEventLines(this.capacity)
    this.ring = history.reverse() // readEventLines 已倒序（最新在前），reverse → 旧→新
  }

  record(input: EventInput): OpsEvent {
    const event: OpsEvent = { ...input, id: randomUUID(), at: new Date().toISOString() }
    this.ring.push(event)
    if (this.ring.length > this.capacity) {
      this.ring.splice(0, this.ring.length - this.capacity)
    }
    void this.storage.appendEvent(event).catch(() => {})
    this.bus.emit('event', { event })
    return event
  }

  /** 便捷方法：任务状态变化 */
  job(job: PrintJob, message: string, data?: Record<string, unknown>): OpsEvent {
    return this.record({ type: 'job', topic: `job:${job.state}`, message, data: { jobId: job.id, printerId: job.printerId, fileName: job.fileName, ...data } })
  }

  printer(printer: Printer, message: string, data?: Record<string, unknown>): OpsEvent {
    return this.record({ type: 'printer', topic: `printer:${printer.status}`, message, data: { printerId: printer.id, ...data } })
  }

  host(message: string, data?: Record<string, unknown>): OpsEvent {
    return this.record({ type: 'host', topic: 'host', message, data })
  }

  test(run: TestRun, message: string): OpsEvent {
    return this.record({ type: 'test', topic: 'test', message, data: { runId: run.runId } })
  }

  list(filter?: { type?: OpsEvent['type']; limit?: number }): OpsEvent[] {
    let items = this.ring
    if (filter?.type) items = items.filter((e) => e.type === filter.type)
    const limit = filter?.limit ?? 200
    return items.slice(-limit).reverse()
  }
}
