import { Router, headerString, parseJsonBody, readBody, sendError, sendJson } from './router'
import type { HostContext } from '../host'
import { exactPageCount, isPdf, makeSamplePdf } from '../pdf/sample'
import { allBackends } from '../backends'
import type { CreatePrinterInput } from '../core/printers'
import type { PrintOptions } from '../core/types'

/** 默认打印选项 */
function defaultOptions(): PrintOptions {
  return { paperSize: 'A4', colorMode: 'color', duplex: 'none', copies: 1, quality: 'normal' }
}

/** 按 header 提交的选项（URL 编码 JSON）解析并按打印机能力钳制 */
function resolveOptions(raw: string | undefined, printerCaps: { color: boolean; duplex: string; maxCopies: number; paperSizes: string[] }, fallback: PrintOptions): PrintOptions {
  const base = { ...defaultOptions(), ...fallback }
  if (raw) {
    try {
      const parsed = JSON.parse(decodeURIComponent(raw)) as Partial<PrintOptions>
      Object.assign(base, parsed)
    } catch {
      /* keep defaults */
    }
  }
  if (!printerCaps.paperSizes.includes(base.paperSize)) base.paperSize = printerCaps.paperSizes[0] ?? 'A4'
  if (!printerCaps.color) base.colorMode = 'monochrome'
  if (base.colorMode !== 'color' && base.colorMode !== 'monochrome') base.colorMode = 'monochrome'
  const duplexAllowed = printerCaps.duplex === 'both' ? ['none', 'long-edge', 'short-edge'] : printerCaps.duplex === 'none' ? ['none'] : ['none', printerCaps.duplex]
  if (!duplexAllowed.includes(base.duplex)) base.duplex = 'none'
  base.copies = Math.max(1, Math.min(printerCaps.maxCopies, Math.floor(Number(base.copies) || 1)))
  if (base.quality !== 'draft' && base.quality !== 'normal' && base.quality !== 'high') base.quality = 'normal'
  return base
}

/** 列表返回时裁剪时间线，详情接口返回全量 */
function trimJobTimeline<T extends { timeline: unknown[] }>(job: T, keep = 30): T {
  return { ...job, timeline: job.timeline.slice(-keep) }
}

export function buildRouter(): Router {
  const router = new Router()

  // ---------------------------------------------------------------- system

  router.get('/api/system/info', (ctx, _req, res) => {
    sendJson(res, 200, ctx.hostInfo())
  })

  router.get('/api/system/stats', async (ctx, _req, res) => {
    const [jobs, storage] = await Promise.all([ctx.jobs.stats(), ctx.storage.stats()])
    const backends = await Promise.all(
      allBackends().map(async (b) => ({ kind: b.kind, available: await b.available(), note: b.availabilityNote })),
    )
    sendJson(res, 200, {
      jobs,
      storage,
      printers: ctx.printers.listAll().map((p) => ({ id: p.id, name: p.name, status: p.status, stats: p.stats, shared: p.shared })),
      backends,
    })
  })

  // ---------------------------------------------------------------- discovery

  router.get('/api/discovery/announce', (ctx, _req, res) => {
    ctx.discovery.announce()
    sendJson(res, 200, { ok: true, host: ctx.discovery.selfInfo() })
  })

  router.get('/api/discovery/hosts', (ctx, _req, res) => {
    ctx.discovery.announce()
    sendJson(res, 200, { hosts: ctx.discovery.hosts() })
  })

  // ---------------------------------------------------------------- printers

  router.get('/api/printers', (ctx, req, res) => {
    const scope = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).searchParams.get('scope') ?? 'client'
    const list = scope === 'admin' ? ctx.printers.listAll() : ctx.printers.listShared()
    const withMeta = list.map((p) => ({ ...p, activeJobId: ctx.engine.activeJobId(p.id) ?? null }))
    sendJson(res, 200, { printers: withMeta })
  })

  router.get('/api/printers/:id', (ctx, _req, res, params) => {
    const printer = ctx.printers.get(params.id)
    if (!printer) return sendError(res, 404, `打印机不存在：${params.id}`)
    sendJson(res, 200, { printer: { ...printer, activeJobId: ctx.engine.activeJobId(printer.id) ?? null } })
  })

  router.post('/api/printers', (ctx, _req, res, _params, _query, body) => {
    const input = parseJsonBody<CreatePrinterInput>(body)
    if (!input?.name) return sendError(res, 400, '请求体必须包含 name 字段')
    const printer = ctx.printers.create({
      name: String(input.name).slice(0, 80),
      description: input.description ? String(input.description).slice(0, 200) : undefined,
      location: input.location ? String(input.location).slice(0, 120) : undefined,
      shared: input.shared ?? true,
      capabilities: input.capabilities,
    })
    sendJson(res, 201, { printer })
  })

  router.patch('/api/printers/:id', (ctx, _req, res, params, _query, body) => {
    const patch = parseJsonBody<{ name?: string; description?: string; location?: string; shared?: boolean }>(body)
    if (!patch) return sendError(res, 400, '请求体不是合法 JSON')
    const printer = ctx.printers.patch(params.id, patch)
    if (!printer) return sendError(res, 404, `打印机不存在：${params.id}`)
    sendJson(res, 200, { printer })
  })

  router.delete('/api/printers/:id', (ctx, _req, res, params) => {
    const printer = ctx.printers.get(params.id)
    if (!printer) return sendError(res, 404, `打印机不存在：${params.id}`)
    if (!printer.virtual) return sendError(res, 400, '仅虚拟打印机可以删除')
    ctx.engine.onPrinterRemoved(printer.id)
    ctx.printers.remove(printer.id)
    void ctx.jobs.removeJobsWhere((j) => j.printerId === printer.id)
    sendJson(res, 200, { ok: true })
  })

  router.post('/api/printers/:id/test-print', async (ctx, _req, res, params) => {
    const printer = ctx.printers.get(params.id)
    if (!printer) return sendError(res, 404, `打印机不存在：${params.id}`)
    const pdf = await makeSamplePdf(2, `${printer.name} 测试页`)
    const job = await ctx.jobs.submit({
      printer,
      pdf,
      fileName: `test-page-${printer.id}.pdf`,
      options: { ...printer.defaultOptions },
      source: { deviceId: 'host-console', deviceName: 'Host 控制台', platform: 'web' },
    })
    sendJson(res, 201, { job })
  })

  // ---------------------------------------------------------------- jobs（打印）

  router.post('/api/jobs', async (ctx, req, res, _params, query, body) => {
    const printerId = query.get('printerId')
    const fileName = query.get('fileName') ?? 'document.pdf'
    if (!printerId) return sendError(res, 400, '缺少 printerId 查询参数')
    const printer = ctx.printers.get(printerId)
    if (!printer) return sendError(res, 404, `打印机不存在：${printerId}`)

    // 安全模式校验（open 模式放行；pairing 模式需设备令牌）
    const auth = ctx.pairing.authorize(typeof req.headers['x-ops-token'] === 'string' ? (req.headers['x-ops-token'] as string) : null)
    if (!auth.ok) return sendError(res, 401, auth.reason ?? '未授权')

    const isAdmin = headerString(req, 'x-ops-admin') === '1'
    if (!printer.shared && !isAdmin) return sendError(res, 403, '打印机未共享，无法提交打印（可在 Host 控制台共享它）')

    if (body.length === 0) return sendError(res, 400, '请求体为空（应为 PDF 二进制）')
    if (!isPdf(new Uint8Array(body))) return sendError(res, 415, '请求体不是有效的 PDF 文件')

    const source = {
      deviceId: headerString(req, 'x-ops-device', 'anonymous'),
      deviceName: headerString(req, 'x-ops-device-name', 'Unknown Device'),
      platform: (headerString(req, 'x-ops-platform', 'web') as never),
    }
    const options = resolveOptions(
      typeof req.headers['x-ops-options'] === 'string' ? (req.headers['x-ops-options'] as string) : undefined,
      printer.capabilities,
      printer.defaultOptions,
    )
    const pageCount = (await exactPageCount(new Uint8Array(body))) ?? undefined
    const job = await ctx.jobs.submit({ printer, pdf: new Uint8Array(body), fileName: fileName.slice(0, 120), options, source, pageCount })
    sendJson(res, 201, { job: trimJobTimeline(job, 12) })
  })

  router.get('/api/jobs', (ctx, req, res) => {
    const search = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).searchParams
    const jobs = ctx.jobs.list({
      printerId: searchParams(search, 'printerId'),
      state: searchParams(search, 'state') as never,
      deviceId: searchParams(search, 'deviceId'),
      limit: search.get('limit') ? Number(search.get('limit')) : undefined,
    })
    sendJson(res, 200, { jobs: jobs.map((j) => trimJobTimeline(j, 16)) })
  })

  router.get('/api/jobs/:id', (ctx, _req, res, params) => {
    const job = ctx.jobs.get(params.id)
    if (!job) return sendError(res, 404, `任务不存在：${params.id}`)
    sendJson(res, 200, { job })
  })

  router.post('/api/jobs/:id/cancel', (ctx, _req, res, params) => {
    const job = ctx.jobs.get(params.id)
    if (!job) return sendError(res, 404, `任务不存在：${params.id}`)
    const result = ctx.engine.cancelJob(job)
    if (!result.ok) return sendError(res, 409, result.message)
    sendJson(res, 200, { ok: true, message: result.message })
  })

  router.post('/api/jobs/:id/retry', (ctx, _req, res, params) => {
    const job = ctx.jobs.get(params.id)
    if (!job) return sendError(res, 404, `任务不存在：${params.id}`)
    const result = ctx.engine.retryJob(job)
    if (!result.ok) return sendError(res, 409, result.message)
    sendJson(res, 200, { ok: true, message: result.message })
  })

  router.get('/api/jobs/:id/events', (ctx, _req, res, params) => {
    const job = ctx.jobs.get(params.id)
    if (!job) return sendError(res, 404, `任务不存在：${params.id}`)
    sendJson(res, 200, { timeline: job.timeline })
  })

  router.get('/api/jobs/:id/document', async (ctx, _req, res, params) => {
    const job = ctx.jobs.get(params.id)
    if (!job) return sendError(res, 404, `任务不存在：${params.id}`)
    const buf = await ctx.storage.readJobDocument(params.id)
    if (!buf) return sendError(res, 404, '原始 PDF 不存在')
    res.writeHead(200, {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="${job.fileName}"`,
      'cache-control': 'no-store',
    })
    res.end(buf)
  })

  router.get('/api/jobs/:id/result', async (ctx, _req, res, params) => {
    const result = await ctx.storage.readJson<unknown>(`jobs/${params.id}/result.json`, null)
    if (!result) return sendError(res, 404, '该任务尚无打印结果')
    sendJson(res, 200, { result })
  })

  // ---------------------------------------------------------------- events

  router.get('/api/events', (ctx, req, res) => {
    const search = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).searchParams
    const type = searchParams(search, 'type')
    const limit = search.get('limit') ? Number(search.get('limit')) : 200
    sendJson(res, 200, { events: ctx.log.list({ type: type as never, limit }) })
  })

  // ---------------------------------------------------------------- pairing / devices / settings

  router.get('/api/pairing/requests', (ctx, _req, res) => {
    sendJson(res, 200, { requests: ctx.pairing.listRequests() })
  })

  router.post('/api/pairing/requests', (ctx, _req, res, _params, _query, body) => {
    const input = parseJsonBody<{ deviceId?: string; deviceName?: string; platform?: string }>(body)
    if (!input?.deviceId) return sendError(res, 400, '请求体必须包含 deviceId')
    const request = ctx.pairing.createRequest({
      deviceId: input.deviceId,
      deviceName: input.deviceName ?? 'Unknown Device',
      platform: (input.platform ?? 'web') as never,
    })
    sendJson(res, 201, { request })
  })

  router.post('/api/pairing/requests/:id/approve', (ctx, _req, res, params) => {
    const result = ctx.pairing.approve(params.id)
    if ('error' in result) return sendError(res, 409, result.error)
    sendJson(res, 200, { ok: true, token: result.token, request: result.request })
  })

  router.post('/api/pairing/requests/:id/reject', (ctx, _req, res, params) => {
    const result = ctx.pairing.reject(params.id)
    if ('error' in result) return sendError(res, 409, result.error)
    sendJson(res, 200, { ok: true, request: result.request })
  })

  /** 设备侧轮询：批准后发放令牌（仅匹配 deviceId） */
  router.get('/api/pairing/status', (ctx, req, res) => {
    const search = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).searchParams
    const deviceId = search.get('deviceId')
    if (!deviceId) return sendError(res, 400, '缺少 deviceId 查询参数')
    sendJson(res, 200, ctx.pairing.statusFor(deviceId))
  })

  router.get('/api/devices', (ctx, _req, res) => {
    sendJson(res, 200, { devices: ctx.pairing.listDevices() })
  })

  router.delete('/api/devices/:deviceId', (ctx, _req, res, params) => {
    const ok = ctx.pairing.revoke(params.deviceId)
    if (!ok) return sendError(res, 404, '设备未配对')
    sendJson(res, 200, { ok: true })
  })

  router.get('/api/settings', (ctx, _req, res) => {
    sendJson(res, 200, { settings: ctx.settings.get() })
  })

  router.patch('/api/settings', (ctx, _req, res, _params, _query, body) => {
    const patch = parseJsonBody<{ hostName?: string; securityMode?: 'open' | 'pairing' }>(body)
    if (!patch) return sendError(res, 400, '请求体不是合法 JSON')
    if (patch.securityMode && patch.securityMode !== 'open' && patch.securityMode !== 'pairing') {
      return sendError(res, 400, 'securityMode 仅支持 open | pairing')
    }
    const settings = ctx.settings.patch({
      hostName: patch.hostName?.slice(0, 80),
      securityMode: patch.securityMode,
    })
    ctx.log.record({ type: 'security', topic: 'settings', message: `Host 设置已更新（安全模式：${settings.securityMode}）` })
    ctx.bus.emit('host:update', { info: ctx.hostInfo() })
    sendJson(res, 200, { settings })
  })

  // ---------------------------------------------------------------- mock / debug 控制台

  router.post('/api/mock/printers/:id/condition', (ctx, _req, res, params, _query, body) => {
    const printer = ctx.printers.get(params.id)
    if (!printer) return sendError(res, 404, `打印机不存在：${params.id}`)
    const input = parseJsonBody<{ condition?: string; message?: string }>(body)
    const condition = input?.condition
    if (condition !== 'offline' && condition !== 'paper-out' && condition !== 'paper-jam' && condition !== 'error' && condition !== 'online') {
      return sendError(res, 400, 'condition 仅支持 online | offline | paper-out | paper-jam | error')
    }
    if (condition === 'online') {
      ctx.engine.setOnline(printer)
    } else {
      ctx.engine.setCondition(printer, condition, input?.message)
    }
    sendJson(res, 200, { ok: true, printer })
  })

  router.post('/api/mock/printers/:id/fix', (ctx, _req, res, params, _query, body) => {
    const printer = ctx.printers.get(params.id)
    if (!printer) return sendError(res, 404, `打印机不存在：${params.id}`)
    const input = parseJsonBody<{ action?: string }>(body)
    const action = input?.action
    if (action !== 'add-paper' && action !== 'clear-jam') return sendError(res, 400, 'action 仅支持 add-paper | clear-jam')
    const result = ctx.engine.fix(printer, action)
    if (!result.ok) return sendError(res, 409, result.message)
    sendJson(res, 200, { ok: true, message: result.message, printer })
  })

  router.post('/api/mock/printers/:id/resume', (ctx, _req, res, params) => {
    const printer = ctx.printers.get(params.id)
    if (!printer) return sendError(res, 404, `打印机不存在：${params.id}`)
    const result = ctx.engine.resume(printer)
    if (!result.ok) return sendError(res, 409, result.message)
    sendJson(res, 200, { ok: true, message: result.message })
  })

  router.post('/api/mock/printers/:id/speed', (ctx, _req, res, params, _query, body) => {
    const printer = ctx.printers.get(params.id)
    if (!printer) return sendError(res, 404, `打印机不存在：${params.id}`)
    const input = parseJsonBody<{ ppm?: number }>(body)
    if (!input?.ppm || Number.isNaN(Number(input.ppm))) return sendError(res, 400, '请求体必须包含 ppm（1–600）')
    ctx.engine.setSpeed(printer, Number(input.ppm))
    sendJson(res, 200, { ok: true, printer })
  })

  router.post('/api/mock/printers/:id/ink', (ctx, _req, res, params) => {
    const printer = ctx.printers.get(params.id)
    if (!printer) return sendError(res, 404, `打印机不存在：${params.id}`)
    ctx.engine.refillInk(printer)
    sendJson(res, 200, { ok: true, printer })
  })

  router.post('/api/mock/printers/:id/reset', (ctx, _req, res, params) => {
    const printer = ctx.printers.get(params.id)
    if (!printer) return sendError(res, 404, `打印机不存在：${params.id}`)
    ctx.engine.resetPrinter(printer)
    sendJson(res, 200, { ok: true, printer })
  })

  router.post('/api/mock/jobs/:id/fail', (ctx, _req, res, params, _query, body) => {
    const job = ctx.jobs.get(params.id)
    if (!job) return sendError(res, 404, `任务不存在：${params.id}`)
    const input = parseJsonBody<{ message?: string }>(body)
    const printer = ctx.printers.get(job.printerId)
    if (!printer) return sendError(res, 404, `打印机不存在：${job.printerId}`)
    const result = ctx.engine.failActive(printer, input?.message ?? 'Simulated printer error（模拟硬件故障）')
    if (!result.ok) return sendError(res, 409, result.message)
    sendJson(res, 200, { ok: true, message: result.message })
  })

  // ---------------------------------------------------------------- debug 工具

  router.get('/api/debug/sample-pdf', async (_ctx, req, res) => {
    const search = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).searchParams
    const pages = Math.max(1, Math.min(20, Number(search.get('pages') ?? 2) || 2))
    const pdf = await makeSamplePdf(pages)
    res.writeHead(200, {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="ops-sample-${pages}p.pdf"`,
      'cache-control': 'no-store',
    })
    res.end(Buffer.from(pdf))
  })

  router.post('/api/debug/restart', (ctx, _req, res) => {
    ctx.restartSimulated()
    sendJson(res, 200, { ok: true, message: 'Host 已模拟重启（从磁盘重新加载状态，进行中任务将恢复）' })
  })

  router.post('/api/storage/clear-test-data', async (ctx, _req, res) => {
    const removedPrinters = ctx.printers.listAll().filter((p) => p.test)
    for (const printer of removedPrinters) {
      ctx.engine.onPrinterRemoved(printer.id)
      ctx.printers.remove(printer.id)
    }
    const removedJobs = await ctx.jobs.removeJobsWhere((j) => j.test === true || removedPrinters.some((p) => p.id === j.printerId))
    const removedRuns = await ctx.storage.clearTestRuns()
    ctx.bus.emit('snapshot', {})
    ctx.log.host(`已清理测试数据：${removedPrinters.length} 台测试打印机 / ${removedJobs} 个任务 / ${removedRuns} 次测试运行`)
    sendJson(res, 200, { ok: true, printers: removedPrinters.length, jobs: removedJobs, testRuns: removedRuns })
  })

  // ---------------------------------------------------------------- self-test

  router.get('/api/tests/scenarios', (ctx, _req, res) => {
    sendJson(res, 200, { scenarios: ctx.selfTest.scenarioMeta() })
  })

  router.post('/api/tests/run', (ctx, _req, res, _params, _query, body) => {
    const input = parseJsonBody<{ ids?: string[] }>(body)
    if (ctx.selfTest.isRunning()) return sendError(res, 409, '已有测试运行中，请等待完成')
    const run = ctx.selfTest.start(input?.ids)
    sendJson(res, 202, { runId: run.runId })
  })

  router.get('/api/tests/runs', async (ctx, _req, res) => {
    const ids = await ctx.storage.listTestRunIds()
    const runs = []
    for (const id of ids.slice(-20).reverse()) {
      const run = await ctx.storage.readJson<unknown>(`test-runs/${id}.json`, null)
      if (run) runs.push(run)
    }
    sendJson(res, 200, { runs })
  })

  router.get('/api/tests/runs/:id', async (ctx, _req, res, params) => {
    const run = await ctx.storage.readJson<unknown>(`test-runs/${params.id}.json`, null)
    if (!run) return sendError(res, 404, `测试运行不存在：${params.id}`)
    sendJson(res, 200, { run })
  })

  return router
}

function searchParams(search: URLSearchParams, key: string): string | undefined {
  const v = search.get(key)
  return v ?? undefined
}
