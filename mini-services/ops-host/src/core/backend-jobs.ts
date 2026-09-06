import type { PrintJob, Printer } from './types'
import type { EventBus } from './eventbus'
import type { EventLog } from './eventlog'
import type { FileStorage } from './storage'
import type { JobManager } from './jobs'
import type { PrinterRegistry } from './printers'
import type { BackendManager, BackendJobStatus } from '../backends/index'

/**
 * BackendJobRunner — 真实后端（非 mock）打印机的任务执行器。
 *
 * 与 VirtualPrintEngine 并存：
 *  - engine.tick 只管 backend==='mock' 的打印机（loadActiveFromDisk 已按此过滤，保持不变）
 *  - 本 runner 只管 backend!=='mock' 的打印机：
 *      pending  → 从 storage 取 PDF → backend.submitJob() → 记 backendJobId → processing
 *      processing → 1s 轮询 getJobStatus → 更新 progress（25/50/75/100 里程碑）→ 终态
 *      cancel → backend.cancelJob（IPP Cancel-Job）→ cancelled
 *
 * 容错（用户红线：协议失败不能把可用打印机搞挂）：
 *  - 提交异常 → 任务 failed + 明确错误信息（如 “IPP 后端不可达”）
 *  - 轮询暂时网络错误 → state='unknown' → 保持 processing + timeline 记 warning，连续 3 次才 failed
 *  - Host 重启：backendJobId 已持久化在 job 数据 → reload() 恢复轮询；无法恢复 → failed 带说明
 */
const TICK_MS = 1000
const POLL_INTERVAL_MS = 1000
const MAX_POLL_FAILURES = 3

export interface RunnerDeps {
  printers: PrinterRegistry
  jobs: JobManager
  storage: FileStorage
  bus: EventBus
  log: EventLog
  backends: BackendManager
}

export class BackendJobRunner {
  private timer: ReturnType<typeof setInterval> | null = null
  /** 正在执行提交的 jobId（防重复提交） */
  private submitting = new Set<string>()
  /** 正在执行轮询的 jobId（防并发轮询） */
  private polling = new Set<string>()
  private lastPollAt = new Map<string, number>()
  private pollFailures = new Map<string, number>()

  constructor(private readonly deps: RunnerDeps) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.tick().catch((err) => console.error('[backend-runner] tick error:', err))
    }, TICK_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  dispose(): void {
    this.stop()
    this.submitting.clear()
    this.polling.clear()
    this.lastPollAt.clear()
    this.pollFailures.clear()
  }

  /**
   * Host 重启恢复：
   *  - processing + backendJobId → timeline 记系统事件并恢复轮询
   *  - processing 无 backendJobId → failed（提交中途丢失，无法恢复）
   *  - pending → 保持，由 tick 重新提交
   */
  reload(): void {
    for (const job of this.deps.jobs.list()) {
      const printer = this.deps.printers.get(job.printerId)
      if (!printer || printer.backend === 'mock') continue
      if (job.state === 'processing') {
        if (job.backendJobId) {
          this.deps.jobs.pushTimeline(job, {
            type: 'system',
            reason: 'host-restart',
            message: `Host 重启：恢复轮询后端任务（backend job ${job.backendJobId}）`,
          })
          void this.deps.jobs.saveJob(job, true)
          this.deps.log.job(job, `Host 重启：恢复真实后端任务 ${job.id}（backend job ${job.backendJobId}）`)
        } else {
          job.error = 'Host 重启时任务尚未提交到后端，无法恢复'
          this.deps.jobs.setState(job, 'failed', job.error)
          void this.deps.jobs.writeResult(job, 'failed', job.error)
        }
      }
    }
  }

  private async tick(): Promise<void> {
    // 1) pending → 提交
    for (const job of this.deps.jobs.list({ state: 'pending' })) {
      if (this.submitting.has(job.id)) continue
      const printer = this.deps.printers.get(job.printerId)
      if (!printer || printer.backend === 'mock') continue
      void this.submitBackendJob(job.id)
    }
    // 2) processing → 轮询（1s 节流）
    const now = Date.now()
    for (const job of this.deps.jobs.list({ state: 'processing' })) {
      if (!job.backendJobId) continue
      if (this.polling.has(job.id)) continue
      const last = this.lastPollAt.get(job.id) ?? 0
      if (now - last < POLL_INTERVAL_MS) continue
      const printer = this.deps.printers.get(job.printerId)
      if (!printer || printer.backend === 'mock') continue
      void this.pollBackendJob(job.id)
    }
    // 3) paused（后端 processing-stopped）→ 低频轮询等待恢复
    for (const job of this.deps.jobs.list({ state: 'paused' })) {
      if (!job.backendJobId) continue
      if (this.polling.has(job.id)) continue
      const last = this.lastPollAt.get(job.id) ?? 0
      if (now - last < POLL_INTERVAL_MS * 3) continue
      const printer = this.deps.printers.get(job.printerId)
      if (!printer || printer.backend === 'mock') continue
      void this.pollBackendJob(job.id)
    }
  }

  private backendFor(printer: Printer) {
    return this.deps.backends.get(printer.backend)
  }

  // ---------------------------------------------------------------- 提交

  private async submitBackendJob(jobId: string): Promise<void> {
    if (this.submitting.has(jobId)) return
    this.submitting.add(jobId)
    try {
      const job = this.deps.jobs.get(jobId)
      if (!job || job.state !== 'pending') return
      const printer = this.deps.printers.get(job.printerId)
      if (!printer || printer.backend === 'mock') return
      const backend = this.backendFor(printer)
      if (!backend) {
        job.error = `打印后端 ${printer.backend} 未注册（Host 未装配该后端）`
        this.deps.jobs.setState(job, 'failed', job.error)
        void this.deps.jobs.writeResult(job, 'failed', job.error)
        return
      }
      const pdf = await this.deps.storage.readJobDocument(jobId)
      if (!pdf) {
        job.error = '原始 PDF 文档丢失（storage 无 document.pdf）'
        this.deps.jobs.setState(job, 'failed', job.error)
        void this.deps.jobs.writeResult(job, 'failed', job.error)
        return
      }
      this.deps.jobs.pushTimeline(job, {
        type: 'system',
        reason: 'backend-submit',
        message: `通过 ${backend.kind} 后端提交：${printer.backendUri ?? printer.backendKey ?? printer.name}`,
      })
      const result = await backend.submitJob({
        printerKey: printer.backendKey ?? printer.id,
        pdf: new Uint8Array(pdf),
        fileName: job.fileName,
        options: job.options,
        userName: job.source.deviceName,
        jobName: job.fileName,
      })
      // 提交期间任务可能被取消/删除 —— 重新校验
      const fresh = this.deps.jobs.get(jobId)
      if (!fresh) return
      if (fresh.state !== 'pending') {
        // 已取消：尽力向后端发送取消（清理远端任务）
        try {
          await backend.cancelJob(printer.backendKey ?? printer.id, result.jobId)
        } catch {
          /* 尽力而为 */
        }
        return
      }
      fresh.backendJobId = result.jobId
      fresh.backendJobUri = result.jobUri ?? undefined
      this.deps.jobs.setState(fresh, 'processing', `后端任务已创建（${backend.kind} job ${result.jobId}）`)
      await this.deps.jobs.saveJob(fresh, true)
      printer.status = 'busy'
      printer.statusMessage = `正在打印 ${fresh.fileName}（${backend.kind}）`
      this.deps.printers.touch(printer, { persist: true })
      this.deps.log.job(fresh, `已通过 ${backend.kind} 后端提交到 ${printer.name}（backend job ${result.jobId}）`)
    } catch (err) {
      const job = this.deps.jobs.get(jobId)
      const message = err instanceof Error ? err.message : String(err)
      if (job && job.state !== 'completed' && job.state !== 'cancelled') {
        job.error = `后端提交失败：${message}`
        this.deps.jobs.setState(job, 'failed', job.error)
        void this.deps.jobs.writeResult(job, 'failed', job.error)
        const printer = this.deps.printers.get(job.printerId)
        if (printer && (printer.status === 'busy' || printer.statusMessage.includes(job.fileName))) {
          printer.status = 'online'
          printer.statusMessage = ''
          this.deps.printers.touch(printer, { persist: true })
        }
      }
    } finally {
      this.submitting.delete(jobId)
    }
  }

  // ---------------------------------------------------------------- 轮询

  private async pollBackendJob(jobId: string): Promise<void> {
    if (this.polling.has(jobId)) return
    this.polling.add(jobId)
    this.lastPollAt.set(jobId, Date.now())
    try {
      const job = this.deps.jobs.get(jobId)
      if (!job || !job.backendJobId) return
      if (job.state !== 'processing' && job.state !== 'paused') return
      const printer = this.deps.printers.get(job.printerId)
      if (!printer || printer.backend === 'mock') return
      const backend = this.backendFor(printer)
      if (!backend) return
      // getJobStatus 契约：失败返回 state='unknown'，不抛异常
      const status = await backend.getJobStatus(printer.backendKey ?? printer.id, job.backendJobId)
      if (status.state === 'unknown') {
        this.recordPollFailure(job, status.message ?? '后端任务状态未知')
        return
      }
      this.pollFailures.delete(jobId)
      await this.applyBackendStatus(job, printer, status)
    } catch (err) {
      const job = this.deps.jobs.get(jobId)
      if (job) this.recordPollFailure(job, err instanceof Error ? err.message : String(err))
    } finally {
      this.polling.delete(jobId)
    }
  }

  private recordPollFailure(job: PrintJob, message: string): void {
    const count = (this.pollFailures.get(job.id) ?? 0) + 1
    this.pollFailures.set(job.id, count)
    if (count === 1) {
      this.deps.jobs.pushTimeline(job, { type: 'system', reason: 'backend-poll-warning', message: `后端状态轮询异常（第 1 次）：${message}` })
      void this.deps.jobs.saveJob(job, true)
    }
    if (count >= MAX_POLL_FAILURES && job.state === 'processing') {
      job.error = `后端状态轮询连续 ${count} 次失败：${message}`
      this.deps.jobs.setState(job, 'failed', job.error)
      void this.deps.jobs.writeResult(job, 'failed', job.error)
      this.pollFailures.delete(job.id)
    }
  }

  private async applyBackendStatus(job: PrintJob, printer: Printer, status: BackendJobStatus): Promise<void> {
    switch (status.state) {
      case 'completed': {
        job.printedSheets = status.sheetsDone ?? job.sheetsTotal
        // 补齐剩余里程碑（与 mock 引擎风格一致：完成时推进到 100%）
        const before = job.progress
        job.progress = 100
        const mBefore = Math.floor(before / 25)
        if (mBefore < 4) {
          for (let m = mBefore + 1; m <= 4; m++) {
            this.deps.jobs.pushProgressMilestone(job, Math.min(m * 25, 100))
          }
        }
        printer.stats.completed += 1
        printer.stats.sheets += job.printedSheets
        this.releasePrinter(printer)
        // 终态顺序保证（竞态修复）：result.json 先落盘、completed 后广播
        await this.deps.jobs.finish(job, 'completed', status.message ?? `后端打印完成（${job.printedSheets} 张）`, `真实后端打印完成（${printer.backend} job ${job.backendJobId}）`)
        return
      }
      case 'failed': {
        job.error = status.message ?? `后端任务失败（${printer.backend} job ${job.backendJobId}）`
        printer.stats.failed += 1
        this.releasePrinter(printer)
        await this.deps.jobs.finish(job, 'failed', job.error, job.error)
        return
      }
      case 'cancelled': {
        printer.stats.cancelled += 1
        this.releasePrinter(printer)
        await this.deps.jobs.finish(job, 'cancelled', status.message ?? '后端任务已取消', '后端任务已取消')
        return
      }
      case 'paused': {
        if (job.state !== 'paused') {
          this.deps.jobs.setState(job, 'paused', status.message ?? '后端任务暂停（processing-stopped）')
        }
        return
      }
      case 'pending': {
        // 后端尚在排队：保持 processing（Host 视角已提交），可记录一次性说明
        return
      }
      case 'processing': {
        if (job.state === 'paused') {
          this.deps.jobs.setState(job, 'processing', status.message ?? '后端任务已恢复')
          printer.status = 'busy'
          this.deps.printers.touch(printer, { persist: true })
        }
        const before = job.progress
        const progress =
          status.progress > 0 ? Math.min(100, Math.round(status.progress)) : status.sheetsDone && status.sheetsDone > 0
            ? Math.min(100, Math.round((status.sheetsDone / Math.max(1, job.sheetsTotal)) * 100))
            : 0
        job.progress = progress
        if (status.sheetsDone !== undefined) job.printedSheets = status.sheetsDone
        else job.printedSheets = Math.round((progress / 100) * job.sheetsTotal * 10) / 10
        // 里程碑 25/50/75/100（与 mock 引擎同风格）
        const mBefore = Math.floor(before / 25)
        const mAfter = Math.floor(job.progress / 25)
        if (mAfter > mBefore) {
          for (let m = mBefore + 1; m <= mAfter; m++) {
            this.deps.jobs.pushProgressMilestone(job, Math.min(m * 25, 100))
          }
        }
        this.deps.jobs.saveJobThrottled(job)
        this.deps.jobs.emit(job)
        return
      }
      default:
        return
    }
  }

  /** 任务终态后释放打印机（无排队任务时回到 online） */
  private releasePrinter(printer: Printer): void {
    const stillBusy = this.deps.jobs.list({ printerId: printer.id }).some((j) => ['pending', 'processing', 'paused'].includes(j.state))
    if (!stillBusy && (printer.status === 'busy' || printer.statusMessage !== '')) {
      printer.status = 'online'
      printer.statusMessage = ''
      this.deps.printers.touch(printer, { persist: true })
    } else {
      this.deps.printers.touch(printer, { persist: true })
    }
  }

  // ---------------------------------------------------------------- 取消（routes /api/jobs/:id/cancel 分派）

  async cancel(job: PrintJob): Promise<{ ok: boolean; message: string }> {
    if (job.state === 'completed' || job.state === 'cancelled') {
      return { ok: false, message: `任务已处于终态（${job.state}）` }
    }
    const printer = this.deps.printers.get(job.printerId)
    if (!printer) return { ok: false, message: '打印机不存在' }
    const backend = this.backendFor(printer)
    if (!backend) return { ok: false, message: `打印后端 ${printer.backend} 未注册` }

    if (!job.backendJobId) {
      // 尚未提交到后端（pending / 提交中）——直接置 cancelled；提交流程会检测状态并放弃
      this.deps.jobs.setState(job, 'cancelled', '任务在后端提交前被取消')
      void this.deps.jobs.writeResult(job, 'cancelled', '任务在后端提交前被取消')
      printer.stats.cancelled += 1
      return { ok: true, message: `任务 ${job.id} 已取消（未提交到后端）` }
    }

    const result = await backend.cancelJob(printer.backendKey ?? printer.id, job.backendJobId)
    if (result.ok) {
      this.deps.jobs.setState(job, 'cancelled', result.message ?? '后端任务已取消（IPP Cancel-Job）')
      void this.deps.jobs.writeResult(job, 'cancelled', `后端 Cancel-Job 生效（${printer.backend} job ${job.backendJobId}）`)
      printer.stats.cancelled += 1
      this.releasePrinter(printer)
      return { ok: true, message: `任务 ${job.id} 已取消（${printer.backend} Cancel-Job 生效）` }
    }
    return { ok: false, message: result.message ?? '后端取消失败' }
  }
}

// ---------------------------------------------------------------- 状态同步循环

/**
 * BackendStatusSync — 非 mock 打印机状态同步（每 5s）。
 *
 *  - IPP printer-state：3 idle→online / 4 processing→busy / 5 stopped→按 reasons 映射
 *    （media-needed → paper-out / media-jam → paper-jam / shutdown 等 → offline / 其它 → error）
 *  - 失败 → 保持原状态 + 事件记 warning（不把打印机打成 offline，除非连续 3 次失败）
 */
const SYNC_INTERVAL_MS = 5000
const SYNC_FAILURE_LIMIT = 3

export class BackendStatusSync {
  private timer: ReturnType<typeof setInterval> | null = null
  private failures = new Map<string, number>()

  constructor(private readonly deps: Omit<RunnerDeps, 'jobs' | 'storage'>) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.sync().catch((err) => console.error('[backend-sync] error:', err))
    }, SYNC_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async syncOnce(): Promise<void> {
    for (const printer of this.deps.printers.listAll()) {
      if (printer.backend === 'mock') continue
      const backend = this.deps.backends.get(printer.backend)
      if (!backend) continue
      const key = printer.backendKey ?? printer.id
      try {
        const { status, message } = await backend.getStatus(key)
        this.failures.delete(printer.id)
        if (printer.status !== status) {
          this.deps.printers.setStatus(printer, status, message)
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const count = (this.failures.get(printer.id) ?? 0) + 1
        this.failures.set(printer.id, count)
        if (count === 1) {
          this.deps.log.printer(printer, `状态探测失败（第 1 次，保持原状态）：${message}`)
        }
        if (count >= SYNC_FAILURE_LIMIT && printer.status !== 'offline') {
          this.deps.printers.setStatus(printer, 'offline', `连续 ${count} 次状态探测失败（后端不可达）`)
        }
      }
    }
  }

  private async sync(): Promise<void> {
    await this.syncOnce()
  }
}
