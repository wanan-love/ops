import type { HostContext } from '../host'
import type { DiscoveredIpPrinter, PrintJob, Printer, ScenarioResult, TestRun, TestStep } from '../core/types'
import { makeSamplePdf, exactPageCount } from '../pdf/sample'
import { runScenarios, scenarioMeta, type ScenarioId } from './scenarios'

/**
 * SelfTestRunner — 内置自动化测试运行器（产品化能力，非外部测试代码）。
 * 在没有真实打印机的环境下验证 Virtual Printer 全部行为，
 * 结果落盘 test-runs/{runId}.json，并通过 WS 'test:progress' 实时推送。
 */
export class SelfTestRunner {
  private current: TestRun | null = null

  constructor(private readonly ctx: HostContext) {}

  isRunning(): boolean {
    return this.current !== null && this.current.status === 'running'
  }

  scenarioMeta(): Array<{ id: string; name: string; description: string }> {
    return scenarioMeta()
  }

  currentRun(): TestRun | null {
    return this.current
  }

  start(ids?: string[]): TestRun {
    if (this.isRunning()) throw new Error('已有测试运行中')
    const selected = (ids?.length ? ids : (scenarioMeta().map((s) => s.id) as ScenarioId[])).filter((id) =>
      scenarioMeta().some((s) => s.id === id),
    ) as ScenarioId[]
    const run: TestRun = {
      runId: `tr-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      status: 'running',
      total: selected.length,
      passed: 0,
      failed: 0,
      results: [],
    }
    this.current = run
    this.ctx.log.test(run, `自动化测试开始：${selected.length} 个场景（run ${run.runId}）`)
    this.emitProgress(run)

    void (async () => {
      const results = await runScenarios(this.ctx, selected, (partial) => {
        run.results = partial
        run.passed = partial.filter((r) => r.status === 'pass').length
        run.failed = partial.filter((r) => r.status === 'fail' || r.status === 'error').length
        // 运行中也落盘（供 /api/tests/runs/:id 轮询）
        void this.ctx.storage.writeJson(`test-runs/${run.runId}.json`, run)
        this.emitProgress(run)
      })
      run.results = results
      run.passed = results.filter((r) => r.status === 'pass').length
      run.failed = results.filter((r) => r.status === 'fail' || r.status === 'error').length
      run.status = 'done'
      run.finishedAt = new Date().toISOString()
      await this.ctx.storage.writeJson(`test-runs/${run.runId}.json`, run)
      this.ctx.log.test(run, `自动化测试结束：${run.passed}/${run.total} 通过（run ${run.runId}）`)
      this.emitProgress(run)
      this.current = null
    })()

    return run
  }

  private emitProgress(run: TestRun): void {
    this.ctx.bus.emit('test:progress', { run: { ...run, results: run.results.map((r) => ({ ...r })) } })
  }
}

// ---------------------------------------------------------------- 场景 API（注入给 scenarios.ts）

export interface ScenarioApi {
  createPrinter(label: string, caps?: Partial<Printer['capabilities']>): Printer
  submit(printer: Printer, pages?: number, copies?: number): Promise<PrintJob>
  getJob(jobId: string): PrintJob
  getPrinter(printerId: string): Printer
  waitFor(jobId: string, predicate: (job: PrintJob) => boolean, timeoutMs?: number): Promise<PrintJob>
  expect(condition: boolean, message: string): void
  step(name: string, detail: string): void
  sleep(ms: number): Promise<void>
  restartHost(): void
  condition(printer: Printer, condition: 'offline' | 'paper-out' | 'paper-jam' | 'error' | 'online'): void
  fix(printer: Printer, action: 'add-paper' | 'clear-jam'): void
  resume(printer: Printer): void
  failActive(printer: Printer, message?: string): void
  cancel(job: PrintJob): void
  artifactExists(job: PrintJob, rel: string): Promise<boolean>
  // ---- 真实后端（阶段 2）----
  /** 从后端导入打印机（SelfTest 隔离 test:true，幂等） */
  importFromBackend(backend: 'ipp' | 'cups' | 'windows', key: string, opts?: { shared?: boolean; displayName?: string }): Promise<Printer>
  /** mDNS 扫描（socket 不可用返回空） */
  mdnsScan(): Promise<DiscoveredIpPrinter[]>
  /** mDNS socket 是否可用（不可用 → 场景应 skipped） */
  mdnsAvailable(): boolean
  /** Virtual IPP Server 是否启用 */
  vippAvailable(): boolean
  /** 读取 vipp 打印机内部任务状态（验证 IPP Cancel-Job 等服务端效果） */
  vippJobState(printerId: string, backendJobId: string): string | null
}

export class ScenarioFailure extends Error {
  constructor(message: string) {
    super(message)
  }
}

/** 场景跳过（组播/后端不可用等环境原因，不算失败） */
export class ScenarioSkipped extends Error {
  constructor(message: string) {
    super(message)
  }
}

export function makeApi(ctx: HostContext, steps: TestStep[]): ScenarioApi {
  return {
    createPrinter(label, caps): Printer {
      return ctx.printers.create({
        name: `TEST ${label}`,
        description: 'Self-Test 场景专用虚拟打印机（可一键清理）',
        location: 'SelfTest',
        shared: false,
        test: true,
        capabilities: { ppm: 60, color: true, duplex: 'both', paperSizes: ['A4', 'Letter'], ...caps },
      })
    },
    async submit(printer, pages = 2, copies = 1) {
      const pdf = await makeSamplePdf(pages, `SelfTest 文档（${pages} 页 × ${copies} 份）`)
      const pageCount = (await exactPageCount(pdf)) ?? pages
      return ctx.jobs.submit({
        printer,
        pdf,
        fileName: `selftest-${pages}p.pdf`,
        options: { paperSize: 'A4', colorMode: 'color', duplex: 'none', copies, quality: 'normal' },
        source: { deviceId: 'ops-selftest', deviceName: 'OPS SelfTest', platform: 'web' },
        test: true,
        pageCount,
      })
    },
    getJob(jobId) {
      const job = ctx.jobs.get(jobId)
      if (!job) throw new ScenarioFailure(`任务 ${jobId} 不存在`)
      return job
    },
    getPrinter(printerId) {
      const printer = ctx.printers.get(printerId)
      if (!printer) throw new ScenarioFailure(`打印机 ${printerId} 不存在`)
      return printer
    },
    async waitFor(jobId, predicate, timeoutMs = 12000) {
      const start = Date.now()
      for (;;) {
        const job = this.getJob(jobId)
        if (predicate(job)) return job
        if (Date.now() - start > timeoutMs) {
          throw new ScenarioFailure(`等待超时（${timeoutMs}ms）：任务 ${jobId} 当前 state=${job.state} progress=${job.progress.toFixed(1)}%`)
        }
        await this.sleep(40)
      }
    },
    expect(condition, message) {
      if (!condition) throw new ScenarioFailure(`断言失败：${message}`)
      steps.push({ name: 'assert', detail: message, ok: true, at: new Date().toISOString() })
    },
    step(name, detail) {
      steps.push({ name, detail, ok: true, at: new Date().toISOString() })
    },
    sleep(ms) {
      return new Promise<void>((resolve) => setTimeout(resolve, ms))
    },
    restartHost() {
      ctx.restartSimulated()
    },
    condition(printer, condition) {
      const p = this.getPrinter(printer.id)
      if (condition === 'online') ctx.engine.setOnline(p)
      else ctx.engine.setCondition(p, condition)
    },
    fix(printer, action) {
      ctx.engine.fix(this.getPrinter(printer.id), action)
    },
    resume(printer) {
      ctx.engine.resume(this.getPrinter(printer.id))
    },
    failActive(printer, message) {
      ctx.engine.failActive(this.getPrinter(printer.id), message)
    },
    cancel(job) {
      const current = this.getJob(job.id)
      const printer = ctx.printers.get(current.printerId)
      // 真实后端打印机 → BackendJobRunner（IPP Cancel-Job）；虚拟打印机 → 引擎取消
      if (printer && printer.backend !== 'mock') {
        void ctx.runner.cancel(current)
      } else {
        ctx.engine.cancelJob(current)
      }
    },
    async artifactExists(job, rel) {
      return ctx.storage.exists(`jobs/${job.id}/${rel}`)
    },
    async importFromBackend(kind, key, opts) {
      const backend = ctx.backends.get(kind)
      if (!backend) throw new ScenarioSkipped(`后端 ${kind} 未装配`)
      const available = await backend.available()
      if (!available) throw new ScenarioSkipped(`后端 ${kind} 当前不可用：${backend.availabilityNote}`)
      const ref = await backend.getPrinter(key)
      if (!ref) throw new ScenarioFailure(`后端 ${kind} 中找不到打印机：${key}`)
      return ctx.printers.importFromBackend(backend, ref, { test: true, shared: opts?.shared ?? false, displayName: opts?.displayName })
    },
    mdnsScan() {
      return ctx.mdns.scan()
    },
    mdnsAvailable() {
      return ctx.mdns.isAvailable()
    },
    vippAvailable() {
      return ctx.vipp !== null
    },
    vippJobState(printerId, backendJobId) {
      if (!ctx.vipp) return null
      const numeric = Number(backendJobId)
      if (!Number.isInteger(numeric)) return null
      return ctx.vipp.jobState(printerId, numeric)
    },
  }
}

export type { ScenarioResult }
