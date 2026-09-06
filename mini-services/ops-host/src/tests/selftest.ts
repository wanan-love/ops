import type { HostContext } from '../host'
import type { DiscoveredIpPrinter, BackendKind, HostInfo, PrintJob, Printer, ScanDevice, ScanJob, ScenarioResult, TestRun, TestStep } from '../core/types'
import { makeSamplePdf, exactPageCount } from '../pdf/sample'
import { probePjlStatus, probePjlSupply } from '../backends/pjl'
import { connect } from 'node:net'
import { runScenarios, scenarioMeta, type ScenarioId } from './scenarios'

/**
 * 自测运行清单 —— 精确追踪本次运行创建/导入/提交的资源，供「全部通过后自动清理」：
 *  - createdPrinterIds：本运行新建的虚拟/导入打印机（成功后删除）
 *  - importedRestores：复用的既有导入条目（成功后恢复导入前的 test/shared 状态，避免把种子打印机永久标记为测试数据）
 *  - jobIds：本运行提交的任务（成功后删除）
 *  - scanJobIds：本运行提交的扫描任务（成功后删除 scan-jobs/{id} 目录，P3）
 * 失败时全部保留供排查，可用调试页「清理测试数据」一键移除。
 */
export interface RunManifest {
  createdPrinterIds: Set<string>
  importedRestores: Map<string, { test: boolean; shared: boolean }>
  jobIds: Set<string>
  scanJobIds: Set<string>
}

export function newRunManifest(): RunManifest {
  return { createdPrinterIds: new Set(), importedRestores: new Map(), jobIds: new Set(), scanJobIds: new Set() }
}

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
      const manifest = newRunManifest()
      const results = await runScenarios(this.ctx, selected, (partial) => {
        run.results = partial
        run.passed = partial.filter((r) => r.status === 'pass').length
        run.failed = partial.filter((r) => r.status === 'fail' || r.status === 'error').length
        // 运行中也落盘（供 /api/tests/runs/:id 轮询）
        void this.ctx.storage.writeJson(`test-runs/${run.runId}.json`, run)
        this.emitProgress(run)
      }, manifest)
      run.results = results
      run.passed = results.filter((r) => r.status === 'pass').length
      run.failed = results.filter((r) => r.status === 'fail' || r.status === 'error').length
      run.status = 'done'
      run.finishedAt = new Date().toISOString()
      if (run.failed === 0) {
        await this.autoCleanup(run, manifest)
      } else {
        this.ctx.log.test(
          run,
          `存在失败/错误场景，测试数据保留供排查（${manifest.createdPrinterIds.size} 台打印机 / ${manifest.jobIds.size} 个任务，可在调试页一键清理）`,
        )
      }
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

  /** 全部通过 → 精确清理本次运行创建的资源（不动其它数据/测试运行历史） */
  private async autoCleanup(run: TestRun, manifest: RunManifest): Promise<void> {
    const ctx = this.ctx
    let removedPrinters = 0
    for (const id of manifest.createdPrinterIds) {
      if (ctx.printers.get(id)) {
        ctx.engine.onPrinterRemoved(id)
        ctx.printers.remove(id)
        removedPrinters++
      }
    }
    let restored = 0
    let touched = false
    for (const [id, snap] of manifest.importedRestores) {
      const printer = ctx.printers.get(id)
      if (printer && (printer.test !== snap.test || printer.shared !== snap.shared)) {
        printer.test = snap.test
        printer.shared = snap.shared
        printer.updatedAt = new Date().toISOString()
        restored++
        touched = true
        ctx.bus.emit('printer:update', { printer })
      }
    }
    const jobIds = manifest.jobIds
    const removedJobs = await ctx.jobs.removeJobsWhere((j) => jobIds.has(j.id))
    // 扫描任务（P3）：走 ScanManager.removeJob（同步内存 Map + 删除 scan-jobs/{id} 目录，内部 fs.rm recursive force；失败忽略）
    let removedScanJobs = 0
    for (const id of manifest.scanJobIds) {
      try {
        if (await ctx.scan.removeJob(id)) removedScanJobs++
      } catch {
        /* 目录不存在 / 已被删除 —— 忽略 */
      }
    }
    if (touched || removedPrinters > 0) await ctx.printers.persistNow()
    if (removedPrinters > 0 || restored > 0 || removedJobs > 0 || removedScanJobs > 0) {
      ctx.bus.emit('snapshot', {})
      ctx.log.test(
        run,
        `全部通过，已自动清理本次运行的测试数据：删除 ${removedPrinters} 台临时打印机 / ${removedJobs} 个任务 / ${removedScanJobs} 个扫描任务 / 恢复 ${restored} 台导入打印机原状态（测试运行历史保留）`,
      )
    }
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
  /** Virtual IPP TLS（ipps）是否实际监听（证书降级/OPS_VIPP_TLS=0 时 false） */
  vippTlsAvailable(): boolean
  /** 直接按 URI 导入后端打印机（不经 URI 注册表，避免测试污染 ipp-uris.json） */
  importFromUri(backend: 'ipp', uri: string, opts?: { displayName?: string }): Promise<Printer>
  /** 读取 vipp 打印机内部任务状态（验证 IPP Cancel-Job 等服务端效果） */
  vippJobState(printerId: string, backendJobId: string): string | null
  // ---- 扫描（P3 · eSCL）----
  /** Virtual eSCL Scanner 是否启用（OPS_VSCAN_ENABLED=0 时 false → 场景 skipped） */
  vscanAvailable(): boolean
  /** 扫描设备列表（vscan 静态档案 + 手动添加 manual） */
  scanDevices(): Promise<ScanDevice[]>
  /** 提交扫描任务（记录到 manifest.scanJobIds，全部通过后自动清理） */
  startScan(
    deviceId: string,
    opts: { format: 'image/png' | 'application/pdf'; dpi: number; colorMode: 'RGB' | 'Grayscale'; inputSource: 'Platen' | 'Feeder'; duplex?: boolean },
  ): Promise<ScanJob>
  /** 读取扫描任务（null = 不存在） */
  scanJob(jobId: string): ScanJob | null
  /** 轮询等待扫描任务满足条件（超时抛 ScenarioFailure） */
  waitForScan(jobId: string, predicate: (job: ScanJob) => boolean, timeoutMs?: number): Promise<ScanJob>
  /** 取消扫描任务（已终态幂等返回） */
  cancelScan(jobId: string): Promise<ScanJob>
  /** 读取某页 PNG 字节（1-based；null = 无图像） */
  scanArtifactBytes(job: ScanJob, page: number): Promise<Uint8Array | null>
  // ---- PDF 导出（P3.5）----
  /** 按需导出 PDF（幂等；非 completed 抛 ScenarioFailure） */
  exportScanPdf(jobId: string): Promise<ScanJob>
  /** 读取导出的 PDF 字节（null = 未导出或文件缺失） */
  scanPdfBytes(job: ScanJob): Promise<Uint8Array | null>
  // ---- 控制台鉴权（P2 安全轮）----
  /** 真实 HTTP 探测（127.0.0.1:{restPort}）：验证 REST 层鉴权行为（401/200 等）
   *  token 省略 → 无鉴权头；'WRONG' → 伪令牌；其他 → x-ops-console-token 令牌 */
  httpProbe(method: string, path: string, opts?: { token?: string; body?: unknown; raw?: boolean }): Promise<{ status: number; json: { error?: string; code?: string; [k: string]: unknown } | null; bodyText: string }>
  /** 直改 settings（场景清理/预备：非 HTTP 通道，不受鉴权门影响） */
  setConsoleAuth(enabled: boolean): Promise<void>
  /** 读取当前控制台令牌（启用态；禁用态 null） */
  consoleToken(): string | null
  // ---- PJL over RAW 9100（P4 · Vendor Adapter 试点）----
  /** Virtual PJL Printer 是否启用（OPS_VPJL_ENABLED=0 时 false → 场景 skipped） */
  vpjlAvailable(): boolean
  /** 直连 PJL 探测（不经 REST/路由层：客户端单元级，INFO STATUS + INFO SUPPLY） */
  pjlDirectProbe(port: number): Promise<{
    status: { ok: boolean; status: string | null; rawCode: string | null; display: string | null }
    supply: { ok: boolean; levelPct: number | null }
  }>
  /** 向 Virtual PJL 发送原始字节（UEL 包裹的数据段 → 验证 RAW 字节累计） */
  pjlSendRaw(data: string): Promise<void>
  /** 轮询等待打印机满足状态条件（IPP 后端状态同步 5s 轮询恢复等；超时抛 ScenarioFailure） */
  waitForPrinterStatus(printerId: string, predicate: (printer: Printer) => boolean, timeoutMs?: number): Promise<Printer>
  // ---- 平台运行时检测（真实性红线）----
  /** 当前 HostInfo 快照（platform / platformRuntime 信号链 / devMode / 后端列表） */
  hostInfo(): HostInfo
  /** 指定后端的可用性说明（动态 getter 输出；null = 后端未装配） */
  backendNote(kind: BackendKind): string | null
  /** 指定后端 available()（运行时检测；null = 后端未装配） */
  backendAvailable(kind: BackendKind): Promise<boolean | null>
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

export function makeApi(ctx: HostContext, steps: TestStep[], manifest?: RunManifest): ScenarioApi {
  return {
    createPrinter(label, caps): Printer {
      const printer = ctx.printers.create({
        name: `TEST ${label}`,
        description: 'Self-Test 场景专用虚拟打印机（全部通过后自动清理）',
        location: 'SelfTest',
        shared: false,
        test: true,
        capabilities: { ppm: 60, color: true, duplex: 'both', paperSizes: ['A4', 'Letter'], ...caps },
      })
      manifest?.createdPrinterIds.add(printer.id)
      return printer
    },
    async submit(printer, pages = 2, copies = 1) {
      const pdf = await makeSamplePdf(pages, `SelfTest 文档（${pages} 页 × ${copies} 份）`)
      const pageCount = (await exactPageCount(pdf)) ?? pages
      const job = await ctx.jobs.submit({
        printer,
        pdf,
        fileName: `selftest-${pages}p.pdf`,
        options: { paperSize: 'A4', colorMode: 'color', duplex: 'none', copies, quality: 'normal' },
        source: { deviceId: 'ops-selftest', deviceName: 'OPS SelfTest', platform: 'web' },
        test: true,
        pageCount,
      })
      manifest?.jobIds.add(job.id)
      return job
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
      // 导入前快照：复用既有条目时记录原 test/shared，供全部通过后恢复（避免把种子/用户打印机永久标记为测试数据）
      const existing = ctx.printers.findExisting(kind, ref)
      const snap = existing ? { test: existing.test, shared: existing.shared } : null
      const printer = await ctx.printers.importFromBackend(backend, ref, { test: true, shared: opts?.shared ?? false, displayName: opts?.displayName })
      if (manifest) {
        if (snap) manifest.importedRestores.set(printer.id, snap)
        else manifest.createdPrinterIds.add(printer.id)
      }
      return printer
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
    vippTlsAvailable() {
      return ctx.vipp !== null && ctx.vipp.tlsActivePort !== null
    },
    async importFromUri(kind, uri, opts) {
      const backend = ctx.backends.get(kind)
      if (!backend) throw new ScenarioSkipped(`后端 ${kind} 未装配`)
      const available = await backend.available()
      if (!available) throw new ScenarioSkipped(`后端 ${kind} 当前不可用：${backend.availabilityNote}`)
      const ref = { key: uri, displayName: opts?.displayName ?? uri, description: `自测直接导入：${uri}`, uri }
      const existing = ctx.printers.findExisting(kind, ref)
      const snap = existing ? { test: existing.test, shared: existing.shared } : null
      const printer = await ctx.printers.importFromBackend(backend, ref, { test: true, shared: false })
      if (manifest) {
        if (snap) manifest.importedRestores.set(printer.id, snap)
        else manifest.createdPrinterIds.add(printer.id)
      }
      return printer
    },
    vippJobState(printerId, backendJobId) {
      if (!ctx.vipp) return null
      const numeric = Number(backendJobId)
      if (!Number.isInteger(numeric)) return null
      return ctx.vipp.jobState(printerId, numeric)
    },
    // ---- 扫描（P3 · eSCL）----
    vscanAvailable() {
      return ctx.vscan !== null
    },
    async scanDevices() {
      return ctx.scan.listDevices(ctx.vscan)
    },
    async startScan(deviceId, opts) {
      const devices = await ctx.scan.listDevices(ctx.vscan)
      const device = devices.find((d) => d.id === deviceId)
      if (!device) throw new ScenarioFailure(`扫描设备不存在：${deviceId}（可用：${devices.map((d) => d.id).join('、')}）`)
      const job = await ctx.scan.startScan(device, opts)
      manifest?.scanJobIds.add(job.id)
      return job
    },
    scanJob(jobId) {
      return ctx.scan.getJob(jobId)
    },
    async waitForScan(jobId, predicate, timeoutMs = 30000) {
      const start = Date.now()
      for (;;) {
        const job = ctx.scan.getJob(jobId)
        if (!job) throw new ScenarioFailure(`扫描任务不存在：${jobId}`)
        if (predicate(job)) return job
        if (Date.now() - start > timeoutMs) {
          throw new ScenarioFailure(`等待超时（${timeoutMs}ms）：扫描任务 ${jobId} 当前 state=${job.state} pagesDone=${job.pagesDone}/${job.pagesTotal}${job.error ? ` error=${job.error}` : ''}`)
        }
        await this.sleep(50)
      }
    },
    async cancelScan(jobId) {
      try {
        return await ctx.scan.cancelJob(jobId)
      } catch (err) {
        throw new ScenarioFailure(err instanceof Error ? err.message : String(err))
      }
    },
    async scanArtifactBytes(job, page) {
      const bytes = await ctx.scan.getJobImageBytes(job, page)
      return bytes ? new Uint8Array(bytes) : null
    },
    async exportScanPdf(jobId) {
      try {
        return await ctx.scan.exportJobPdf(jobId)
      } catch (err) {
        throw new ScenarioFailure(err instanceof Error ? err.message : String(err))
      }
    },
    async scanPdfBytes(job) {
      const bytes = await ctx.scan.getJobPdfBytes(job)
      return bytes ? new Uint8Array(bytes) : null
    },
    // ---- 控制台鉴权（P2 安全轮）----
    async httpProbe(method, path, opts) {
      const headers: Record<string, string> = {}
      if (opts?.body !== undefined) headers['content-type'] = 'application/json'
      if (typeof opts?.token === 'string' && opts.token !== '') headers['x-ops-console-token'] = opts.token
      const res = await fetch(`http://127.0.0.1:${ctx.restPort}${path}`, {
        method,
        headers,
        body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
      })
      const bodyText = await res.text()
      let json: { error?: string; code?: string; [k: string]: unknown } | null = null
      try {
        json = bodyText ? (JSON.parse(bodyText) as typeof json) : null
      } catch {
        json = null
      }
      return { status: res.status, json, bodyText }
    },
    async setConsoleAuth(enabled) {
      if (enabled) await ctx.settings.enableConsoleAuth()
      else await ctx.settings.disableConsoleAuth()
      ctx.bus.emit('host:update', { info: ctx.hostInfo() })
    },
    consoleToken() {
      return ctx.settings.consoleToken()
    },
    // ---- PJL over RAW 9100（P4 · Vendor Adapter 试点）----
    vpjlAvailable() {
      return ctx.vpjl !== null
    },
    async pjlDirectProbe(port) {
      const opts = { host: '127.0.0.1', port, timeoutMs: 1500 }
      const [status, supply] = await Promise.all([probePjlStatus(opts), probePjlSupply(opts)])
      const level = supply.ok ? (supply.report.consumables.value?.[0]?.levelPct ?? null) : null
      return {
        status: { ok: status.ok, status: status.status, rawCode: status.rawCode, display: status.display },
        supply: { ok: supply.ok, levelPct: level },
      }
    },
    pjlSendRaw(data) {
      return new Promise<void>((resolve, reject) => {
        const socket = connect({ host: '127.0.0.1', port: ctx.vpjl?.port ?? 3067 })
        socket.on('error', reject)
        socket.on('connect', () => {
          socket.end(data, 'latin1', () => resolve())
        })
        setTimeout(() => {
          socket.destroy()
          resolve()
        }, 2000).unref?.()
      })
    },
    async waitForPrinterStatus(printerId, predicate, timeoutMs = 12000) {
      const startedAt = Date.now()
      for (;;) {
        const printer = ctx.printers.get(printerId)
        if (!printer) throw new ScenarioFailure(`打印机不存在：${printerId}`)
        if (predicate(printer)) return printer
        if (Date.now() - startedAt > timeoutMs) {
          throw new ScenarioFailure(`等待打印机状态超时（${timeoutMs}ms，当前 ${printer.status}）`)
        }
        await new Promise((r) => setTimeout(r, 500))
      }
    },
    hostInfo() {
      return ctx.hostInfo()
    },
    backendNote(kind) {
      const backend = ctx.backends.get(kind)
      return backend ? backend.availabilityNote : null
    },
    async backendAvailable(kind) {
      const backend = ctx.backends.get(kind)
      return backend ? await backend.available() : null
    },
  }
}

export type { ScenarioResult }
