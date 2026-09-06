import type { InkLevels, PrintJob, Printer, PrinterStatus } from './types'
import type { EventBus } from './eventbus'
import type { EventLog } from './eventlog'
import type { JobManager } from './jobs'
import type { PrinterRegistry } from './printers'

const TICK_MS = 250
const LOW_INK_THRESHOLD = 15

export type MockCondition = 'offline' | 'paper-out' | 'paper-jam' | 'error'
export type FixAction = 'add-paper' | 'clear-jam'

/**
 * VirtualPrintEngine — Virtual Printer 模拟引擎（MockPrinterBackend 的执行核心）。
 *
 * 职责：
 *  - 每台虚拟打印机一条 FIFO 队列，同一时刻最多一个任务在打印（多台打印机之间并行）
 *  - 按 ppm 推进进度，跨过 25/50/75/100 里程碑时写入任务时间线
 *  - 模拟墨量消耗（彩色/黑白费率不同），低墨预警、墨尽转 error
 *  - 条件注入：offline / paper-out / paper-jam / error，可修复、可恢复续打
 *  - 全部状态落盘：Host 重启（或 /api/debug/restart）后从磁盘恢复并继续打印
 *
 * 未来接入真实打印机时：本引擎整体被 WindowsPrinterBackend / CupsPrinterBackend
 * 的异步 spool 驱动替换，JobManager / 队列 / 协议 / UI 不受影响。
 */
export class VirtualPrintEngine {
  private timer: ReturnType<typeof setInterval> | null = null
  private tickCount = 0
  /** printerId → 正在处理（含暂停）的 jobId */
  private active = new Map<string, string>()

  constructor(
    private readonly printers: PrinterRegistry,
    private readonly jobs: JobManager,
    private readonly bus: EventBus,
    private readonly log: EventLog,
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      try {
        this.tick()
      } catch (err) {
        console.error('[engine] tick error:', err)
      }
    }, TICK_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  dispose(): void {
    this.stop()
    this.active.clear()
  }

  activeJobId(printerId: string): string | undefined {
    return this.active.get(printerId)
  }

  /** Host 重启后：把磁盘上仍处于 processing 的任务重新挂回引擎 */
  loadActiveFromDisk(): void {
    this.active.clear()
    for (const printer of this.printers.listAll()) {
      if (printer.backend !== 'mock') continue
      const inFlight = this.jobs.list({ printerId: printer.id }).find((j) => j.state === 'processing' || j.state === 'paused')
      if (inFlight) {
        this.active.set(printer.id, inFlight.id)
        if (printer.status === 'busy' && inFlight.state === 'paused') {
          // 打印机在线但任务暂停：等待 Resume
          this.printers.setStatus(printer, 'online', '')
        }
      } else if (printer.status === 'busy') {
        // 没有进行中任务却显示 busy：归一化
        this.printers.setStatus(printer, 'online', '')
      }
      const hasPending = this.jobs.queueFor(printer.id).length > 0
      if (printer.status === 'online' && hasPending && inFlight) {
        /* 等待 tick 调度 */
      }
    }
  }

  // ------------------------------------------------------------------ tick

  private tick(): void {
    this.tickCount += 1
    for (const printer of this.printers.listAll()) {
      if (printer.backend !== 'mock') continue
      try {
        this.tickPrinter(printer)
      } catch (err) {
        console.error(`[engine] tickPrinter(${printer.id}) error:`, err)
      }
    }
    if (this.tickCount % 16 === 0) {
      this.printers.persistThrottled(0) // ~4s 强制刷一次（若 dirty）
    }
  }

  private tickPrinter(printer: Printer): void {
    // 1) 空闲且无阻塞 → 取队首任务开印
    if (!this.active.has(printer.id) && printer.status === 'online') {
      const queue = this.jobs.queueFor(printer.id)
      const next = queue.find((j) => j.state === 'pending')
      if (next) {
        this.startJob(printer, next)
      } else if (printer.statusMessage === '' && queue.length === 0) {
        /* nothing to do */
      }
    }

    // 2) 离线时向队首 pending 任务登记一次“等待恢复”
    if (printer.status === 'offline') {
      const pending = this.jobs.queueFor(printer.id).find((j) => j.state === 'pending')
      if (pending && !pending.timeline.some((e) => e.reason === 'printer-offline-waiting')) {
        this.jobs.pushTimeline(pending, {
          type: 'printer',
          reason: 'printer-offline-waiting',
          message: `打印机离线，任务等待恢复（Waiting for printer online）`,
        })
        this.log.job(pending, `打印机离线，任务等待恢复：${pending.fileName}`)
      }
    }

    // 3) 推进打印
    const jobId = this.active.get(printer.id)
    if (!jobId) return
    const job = this.jobs.get(jobId)
    if (!job || job.state !== 'processing') return
    if (printer.status !== 'busy') return // 条件暂停中

    this.advance(printer, job)
  }

  private startJob(printer: Printer, job: PrintJob): void {
    this.active.set(printer.id, job.id)
    this.jobs.setState(job, 'processing', `开始打印（${job.sheetsTotal} 张，${this.effectivePpm(printer)} ppm）`)
    printer.status = 'busy'
    printer.statusMessage = `正在打印 ${job.fileName}`
    this.printers.touch(printer, { persist: true })
    this.log.printer(printer, `开始打印任务 ${job.id}（${job.fileName}）`)
  }

  private effectivePpm(printer: Printer): number {
    return printer.speedOverridePpm ?? printer.capabilities.ppm
  }

  private advance(printer: Printer, job: PrintJob): void {
    const sheetsPerTick = (this.effectivePpm(printer) / 60) * (TICK_MS / 1000)
    const before = job.progress
    job.progress = Math.min(100, before + (sheetsPerTick / job.sheetsTotal) * 100)
    job.printedSheets = Math.round((job.progress / 100) * job.sheetsTotal * 10) / 10

    this.consumeInk(printer, job, sheetsPerTick)

    // 里程碑 25 / 50 / 75 / 100
    const mBefore = Math.floor(before / 25)
    const mAfter = Math.floor(job.progress / 25)
    if (mAfter > mBefore) {
      for (let m = mBefore + 1; m <= mAfter; m++) {
        const milestone = Math.min(m * 25, 100)
        this.jobs.pushProgressMilestone(job, milestone)
      }
    }

    if (job.progress >= 100) {
      this.completeJob(printer, job)
    } else {
      this.jobs.saveJobThrottled(job)
      this.jobs.emit(job)
    }
  }

  private completeJob(printer: Printer, job: PrintJob): void {
    this.active.delete(printer.id)
    job.printedSheets = job.sheetsTotal
    job.progress = 100
    this.jobs.setState(job, 'completed', `打印完成（${job.sheetsTotal} 张）`)
    void this.jobs.writeResult(job, 'success', 'Virtual Printer 模拟打印完成')
    printer.stats.completed += 1
    printer.stats.sheets += job.sheetsTotal
    printer.status = 'online'
    printer.statusMessage = ''
    this.printers.touch(printer, { persist: true })
    this.log.printer(printer, `任务完成 ${job.id}（${job.fileName}）`)
  }

  // ------------------------------------------------------------- 条件注入

  /** 注入打印机条件（Debug：Set Offline / Paper Out / Paper Jam / Error） */
  setCondition(printer: Printer, condition: MockCondition, message?: string): void {
    const defaultMessage: Record<MockCondition, string> = {
      offline: '打印机离线（模拟）',
      'paper-out': '缺纸：请补纸后 Resume',
      'paper-jam': '卡纸：请清除卡纸后 Resume',
      error: '打印机错误（模拟）',
    }
    const jobId = this.active.get(printer.id)
    const job = jobId ? this.jobs.get(jobId) : undefined
    if (job && job.state === 'processing') {
      this.pauseJob(printer, job, condition, message ?? defaultMessage[condition])
    } else if (job && job.state === 'paused' && printer.status !== condition) {
      this.jobs.pushTimeline(job, { type: 'condition', reason: condition, message: `任务保持暂停；打印机进入 ${condition} 状态` })
    } else {
      const pending = this.jobs.queueFor(printer.id).find((j) => j.state === 'pending')
      if (pending && condition === 'offline') {
        // 离线等待事件会在 tick 中登记
      }
    }
    this.printers.setStatus(printer, condition as PrinterStatus, message ?? defaultMessage[condition])
  }

  private pauseJob(printer: Printer, job: PrintJob, reason: string, message: string): void {
    this.jobs.setState(job, 'paused', message, reason)
    printer.statusMessage = message
    this.printers.touch(printer, { persist: true })
  }

  /** Set Online：清除任意条件；离线导致的暂停自动续印（等待恢复→继续打印） */
  setOnline(printer: Printer, message?: string): void {
    const wasCondition = printer.status !== 'online' && printer.status !== 'busy'
    printer.status = 'online'
    printer.statusMessage = ''
    const jobId = this.active.get(printer.id)
    const job = jobId ? this.jobs.get(jobId) : undefined
    if (job && job.state === 'paused' && wasCondition) {
      // resumeJob 会把打印机设为 busy 并持久化/广播，这里不能再用 setStatus 覆盖回 online
      this.resumeJob(printer, job, 'Printer back online — auto resume')
      return
    }
    this.printers.setStatus(printer, 'online', message ?? '')
  }

  /** 修复动作：add-paper（补纸）/ clear-jam（清卡）。只修复硬件，任务保持暂停等待 Resume */
  fix(printer: Printer, action: FixAction): { ok: boolean; message: string } {
    const expects: Record<FixAction, PrinterStatus> = { 'add-paper': 'paper-out', 'clear-jam': 'paper-jam' }
    const expected = expects[action]
    if (printer.status !== expected) {
      return { ok: false, message: `当前状态为 ${printer.status}，无需执行该修复` }
    }
    printer.status = 'online'
    printer.statusMessage = ''
    this.printers.setStatus(printer, 'online', action === 'add-paper' ? '已补纸（Paper refilled）' : '已清除卡纸（Jam cleared）')
    const jobId = this.active.get(printer.id)
    const job = jobId ? this.jobs.get(jobId) : undefined
    if (job && job.state === 'paused') {
      this.jobs.pushTimeline(job, { type: 'condition', reason: action, message: '硬件已修复，任务等待 Resume' })
    }
    return { ok: true, message: action === 'add-paper' ? '已补纸，任务等待恢复' : '已清除卡纸，任务等待恢复' }
  }

  /** Resume：恢复暂停任务；若阻塞条件仍在则返回错误 */
  resume(printer: Printer): { ok: boolean; message: string } {
    const jobId = this.active.get(printer.id)
    const job = jobId ? this.jobs.get(jobId) : undefined
    if (!job || job.state !== 'paused') {
      return { ok: false, message: '该打印机当前没有暂停中的任务' }
    }
    if (printer.status !== 'online' && printer.status !== 'busy') {
      return { ok: false, message: `无法恢复：打印机仍处于 ${printer.status} 状态，请先修复硬件并 Set Online` }
    }
    this.resumeJob(printer, job, 'Manual resume')
    return { ok: true, message: `已恢复任务 ${job.id}` }
  }

  private resumeJob(printer: Printer, job: PrintJob, reason: string): void {
    this.jobs.setState(job, 'processing', `恢复打印（${reason}）`, reason)
    printer.status = 'busy'
    printer.statusMessage = `正在打印 ${job.fileName}`
    this.printers.touch(printer, { persist: true })
    this.log.printer(printer, `任务恢复 ${job.id}（${reason}）`)
  }

  /** Fail Current Job：当前任务 → failed，打印机 → error */
  failActive(printer: Printer, message = 'Simulated printer error（模拟硬件故障）'): { ok: boolean; message: string } {
    const jobId = this.active.get(printer.id)
    const job = jobId ? this.jobs.get(jobId) : undefined
    if (!job || job.state === 'processing' || job.state === 'paused') {
      if (job) {
        this.active.delete(printer.id)
        job.error = message
        this.jobs.setState(job, 'failed', message)
        void this.jobs.writeResult(job, 'failed', message)
        printer.stats.failed += 1
      }
      printer.status = 'error'
      printer.statusMessage = message
      this.printers.setStatus(printer, 'error', message)
      return { ok: true, message: job ? `任务 ${job.id} 已失败：${message}` : `无进行中任务，打印机进入 error 状态` }
    }
    return { ok: false, message: '当前没有可失败的任务' }
  }

  /** Cancel Current Job / 任意任务取消 */
  cancelJob(job: PrintJob): { ok: boolean; message: string } {
    if (job.state === 'completed' || job.state === 'cancelled') {
      return { ok: false, message: `任务已处于终态（${job.state}）` }
    }
    const printer = this.printers.get(job.printerId)
    const wasActive = this.active.get(job.printerId) === job.id
    if (wasActive) this.active.delete(job.printerId)
    this.jobs.setState(job, 'cancelled', '任务被取消（Cancelled by user）')
    void this.jobs.writeResult(job, 'cancelled', '任务被取消')
    if (printer) {
      printer.stats.cancelled += 1
      if (printer.status === 'busy' || printer.statusMessage.includes(job.fileName)) {
        printer.status = 'online'
        printer.statusMessage = ''
      }
      this.printers.touch(printer, { persist: true })
    }
    return { ok: true, message: `任务 ${job.id} 已取消` }
  }

  /** Retry：failed / cancelled → 重新排队 */
  retryJob(job: PrintJob): { ok: boolean; message: string } {
    if (job.state !== 'failed' && job.state !== 'cancelled') {
      return { ok: false, message: '仅失败或已取消的任务可以重试' }
    }
    job.error = null
    job.progress = 0
    job.printedSheets = 0
    job.inkUsed = { cyan: 0, magenta: 0, yellow: 0, black: 0 }
    job.submittedAt = new Date().toISOString()
    this.jobs.setState(job, 'pending', '任务已重新排队（Retry）', 'retry')
    return { ok: true, message: `任务 ${job.id} 已重新排队` }
  }

  // ------------------------------------------------------------- 调试旋钮

  setSpeed(printer: Printer, ppm: number): void {
    const clamped = Math.max(1, Math.min(600, Math.round(ppm)))
    printer.speedOverridePpm = clamped
    this.printers.touch(printer, { persist: true })
    this.log.printer(printer, `模拟打印速度调整为 ${clamped} ppm`)
  }

  refillInk(printer: Printer): void {
    printer.ink = { cyan: 100, magenta: 100, yellow: 100, black: 100 }
    if (printer.status === 'error' && printer.statusMessage.includes('墨')) {
      printer.status = 'online'
      printer.statusMessage = ''
      const jobId = this.active.get(printer.id)
      const job = jobId ? this.jobs.get(jobId) : undefined
      if (job && job.state === 'paused') this.jobs.pushTimeline(job, { type: 'condition', reason: 'ink-refilled', message: '已加墨，任务等待 Resume' })
    }
    this.printers.touch(printer, { persist: true })
    this.log.printer(printer, '墨量已补充至 100%')
  }

  /** 重置打印机：取消进行中任务、清除条件、补满墨（统计保留） */
  resetPrinter(printer: Printer): void {
    const jobId = this.active.get(printer.id)
    const job = jobId ? this.jobs.get(jobId) : undefined
    if (job && (job.state === 'processing' || job.state === 'paused')) {
      this.cancelJob(job)
    }
    this.active.delete(printer.id)
    printer.status = 'online'
    printer.statusMessage = ''
    printer.ink = { cyan: 100, magenta: 100, yellow: 100, black: 100 }
    printer.speedOverridePpm = null
    this.printers.touch(printer, { persist: true })
    this.log.printer(printer, `打印机已重置：${printer.name}`)
  }

  onPrinterRemoved(printerId: string): void {
    const jobId = this.active.get(printerId)
    if (jobId) {
      const job = this.jobs.get(jobId)
      if (job && (job.state === 'processing' || job.state === 'paused')) {
        job.error = '打印机已被移除'
        this.jobs.setState(job, 'failed', '打印机已被移除，任务失败')
        void this.jobs.writeResult(job, 'failed', 'Printer removed')
      }
    }
    this.active.delete(printerId)
  }

  // ------------------------------------------------------------- 墨量模拟

  private consumeInk(printer: Printer, job: PrintJob, sheets: number): void {
    const color = job.options.colorMode === 'color' && printer.capabilities.color
    const qualityFactor = job.options.quality === 'draft' ? 0.7 : job.options.quality === 'high' ? 1.4 : 1
    const cmy = (color ? 0.5 : 0) * qualityFactor
    const k = (color ? 0.9 : 1.8) * qualityFactor
    const usage: InkLevels = {
      cyan: (sheets * cmy) / 100,
      magenta: (sheets * cmy) / 100,
      yellow: (sheets * cmy) / 100,
      black: (sheets * k) / 100,
    }
    job.inkUsed.cyan += usage.cyan
    job.inkUsed.magenta += usage.magenta
    job.inkUsed.yellow += usage.yellow
    job.inkUsed.black += usage.black
    printer.ink.cyan = Math.max(0, printer.ink.cyan - usage.cyan)
    printer.ink.magenta = Math.max(0, printer.ink.magenta - usage.magenta)
    printer.ink.yellow = Math.max(0, printer.ink.yellow - usage.yellow)
    printer.ink.black = Math.max(0, printer.ink.black - usage.black)

    // 低墨预警（每台打印机只提醒一次直到加墨）
    if (printer.statusMessage === '' && printer.status === 'busy') {
      const lowest = Math.min(printer.ink.cyan, printer.ink.magenta, printer.ink.yellow, printer.ink.black)
      if (lowest <= LOW_INK_THRESHOLD && lowest > 0) {
        this.log.printer(printer, `⚠️ 低墨预警（Low Ink/Toner ${lowest.toFixed(0)}%）：${printer.name}`)
        this.jobs.pushTimeline(job, { type: 'condition', reason: 'low-ink', message: `低墨预警（${lowest.toFixed(0)}%）` })
      }
    }

    // 墨尽 → 打印机错误并暂停任务
    if (printer.ink.black <= 0 || (color && (printer.ink.cyan <= 0 || printer.ink.magenta <= 0 || printer.ink.yellow <= 0))) {
      if (job.state === 'processing') {
        this.pauseJob(printer, job, 'error', '墨水/碳粉耗尽（Out of ink — 请在调试面板加墨）')
        this.printers.setStatus(printer, 'error', '墨水/碳粉耗尽（Out of ink）')
      }
    }
  }
}
