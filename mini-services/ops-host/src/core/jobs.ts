import { randomUUID } from 'node:crypto'
import type { JobSource, PrintJob, PrintOptions, Printer, TimelineEntry } from './types'
import type { FileStorage } from './storage'
import type { EventBus } from './eventbus'
import type { EventLog } from './eventlog'

const MAX_TIMELINE = 200

export interface SubmitJobInput {
  printer: Printer
  pdf: Uint8Array
  fileName: string
  options: PrintOptions
  source: JobSource
  test?: boolean
  /** 由协议层用 pdf-lib 解析的精确页数；缺省时用正则估算 */
  pageCount?: number
}

function nowIso(): string {
  return new Date().toISOString()
}

function emptyInk(): { cyan: number; magenta: number; yellow: number; black: number } {
  return { cyan: 0, magenta: 0, yellow: 0, black: 0 }
}

/**
 * JobManager：任务数据 + FIFO 队列 + 状态时间线 + 工件落盘。
 * “谁来推进任务”（VirtualPrintEngine / 未来的 CUPS/Win32 驱动）被刻意排除在外。
 */
export class JobManager {
  private jobs = new Map<string, PrintJob>()
  private lastSavedAt = new Map<string, number>()

  constructor(
    private readonly storage: FileStorage,
    private readonly bus: EventBus,
    private readonly log: EventLog,
  ) {}

  async load(): Promise<PrintJob[]> {
    this.jobs.clear()
    const ids = await this.storage.listJobIds()
    const loaded: PrintJob[] = []
    for (const id of ids) {
      const job = await this.storage.readJson<PrintJob | null>(`jobs/${id}/job.json`, null)
      if (job && job.id === id) {
        this.jobs.set(id, job)
        loaded.push(job)
      }
    }
    return loaded
  }

  async submit(input: SubmitJobInput): Promise<PrintJob> {
    const { printer, pdf, fileName, options, source, test } = input
    const id = `job-${randomUUID().slice(0, 8)}`
    const pageCount = input.pageCount ?? this.pageCountSafe(pdf)
    const sheetsTotal = Math.max(1, Math.ceil((pageCount * options.copies) / (options.duplex === 'none' ? 1 : 2)))
    const job: PrintJob = {
      id,
      printerId: printer.id,
      source,
      fileName,
      sizeBytes: pdf.byteLength,
      pageCount,
      sheetsTotal,
      options,
      state: 'pending',
      progress: 0,
      error: null,
      timeline: [],
      submittedAt: nowIso(),
      startedAt: null,
      endedAt: null,
      printedSheets: 0,
      inkUsed: emptyInk(),
      test,
    }
    await this.storage.saveJobDocument(id, pdf)
    this.jobs.set(id, job)
    printer.stats.submitted += 1

    this.pushTimeline(job, { type: 'state', to: 'pending', message: `已提交到 ${printer.name}（${job.pageCount} 页 × ${options.copies} 份 ≈ ${job.sheetsTotal} 张）` })
    await this.saveJob(job, true)
    this.bus.emit('job:update', { job })
    this.log.job(job, `任务已提交：${fileName} → ${printer.name}`, { options })
    return job
  }

  /** 粗略 PDF 页数（不引依赖时的兜底） */
  private pageCountSafe(pdf: Uint8Array): number {
    const text = Buffer.from(pdf.slice(0, Math.min(pdf.byteLength, 2 * 1024 * 1024))).toString('latin1')
    const matches = text.match(/\/Type\s*\/Page[^s]/g)
    if (matches && matches.length > 0) return matches.length
    const countIdx = text.indexOf('/Count ')
    if (countIdx >= 0) {
      const m = /\d+/.exec(text.slice(countIdx + 8, countIdx + 16))
      if (m) return Math.max(1, parseInt(m[0], 10))
    }
    return 1
  }

  get(id: string): PrintJob | undefined {
    return this.jobs.get(id)
  }

  list(filter?: { printerId?: string; state?: PrintJob['state']; deviceId?: string; test?: boolean; limit?: number }): PrintJob[] {
    let items = [...this.jobs.values()]
    if (filter?.printerId) items = items.filter((j) => j.printerId === filter.printerId)
    if (filter?.state) items = items.filter((j) => j.state === filter.state)
    if (filter?.deviceId) items = items.filter((j) => j.source.deviceId === filter.deviceId)
    if (filter.test === false) items = items.filter((j) => !j.test)
    items.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
    return filter?.limit ? items.slice(0, filter.limit) : items
  }

  queueFor(printerId: string): PrintJob[] {
    return this.list({ printerId, state: 'pending' }).reverse() // 先提交的在前
  }

  pushTimeline(job: PrintJob, entry: Omit<TimelineEntry, 'at'>): TimelineEntry {
    const full: TimelineEntry = { ...entry, at: nowIso() }
    job.timeline.push(full)
    if (job.timeline.length > MAX_TIMELINE) job.timeline.splice(0, job.timeline.length - MAX_TIMELINE)
    return full
  }

  setState(job: PrintJob, state: PrintJob['state'], message?: string, reason?: string): void {
    const from = job.state
    job.state = state
    this.pushTimeline(job, { type: 'state', from, to: state, message, reason })
    if (state === 'processing' && !job.startedAt) job.startedAt = nowIso()
    if (state === 'completed' || state === 'failed' || state === 'cancelled') job.endedAt = nowIso()
    void this.saveJob(job, true)
    this.bus.emit('job:update', { job })
    this.log.job(job, message ?? `任务 ${job.fileName} → ${state}`, { reason })
  }

  pushProgressMilestone(job: PrintJob, progress: number): void {
    this.pushTimeline(job, { type: 'progress', progress, message: `进度 ${progress}%` })
    void this.saveJob(job, true)
    this.bus.emit('job:update', { job })
  }

  /** 节流保存：processing 期间每 500ms 落一次盘（Host 重启可恢复进度） */
  saveJobThrottled(job: PrintJob, minIntervalMs = 500): void {
    const last = this.lastSavedAt.get(job.id) ?? 0
    if (Date.now() - last < minIntervalMs) return
    void this.saveJob(job)
  }

  async saveJob(job: PrintJob, force = false): Promise<void> {
    if (!force) {
      const last = this.lastSavedAt.get(job.id) ?? 0
      if (Date.now() - last < 200) return
    }
    this.lastSavedAt.set(job.id, Date.now())
    await this.storage.writeJson(`jobs/${job.id}/job.json`, job)
  }

  async writeResult(job: PrintJob, outcome: 'success' | 'failed' | 'cancelled', message: string): Promise<void> {
    const durationMs = job.startedAt && job.endedAt ? new Date(job.endedAt).getTime() - new Date(job.startedAt).getTime() : 0
    const result = {
      jobId: job.id,
      outcome,
      message,
      startedAt: job.startedAt,
      completedAt: job.endedAt ?? nowIso(),
      durationMs,
      sheets: job.printedSheets,
      inkUsed: job.inkUsed,
      options: job.options,
      document: `jobs/${job.id}/document.pdf`,
    }
    await this.storage.writeJson(`jobs/${job.id}/result.json`, result)
  }

  emit(job: PrintJob): void {
    this.bus.emit('job:update', { job })
  }

  async removeJob(id: string): Promise<void> {
    this.jobs.delete(id)
    await this.storage.remove(`jobs/${id}`)
  }

  async removeJobsWhere(predicate: (job: PrintJob) => boolean): Promise<number> {
    const victims = this.list().filter(predicate)
    for (const job of victims) {
      await this.removeJob(job.id)
    }
    return victims.length
  }

  stats(): Record<string, number> {
    const byState: Record<string, number> = { pending: 0, processing: 0, paused: 0, completed: 0, failed: 0, cancelled: 0 }
    for (const job of this.jobs.values()) {
      byState[job.state] = (byState[job.state] ?? 0) + 1
    }
    return byState
  }
}
