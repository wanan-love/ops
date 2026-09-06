import { Router, consoleAuthGate, extractConsoleToken, headerString, parseJsonBody, readBody, sendError, sendJson } from './router'
import type { HostContext } from '../host'
import { exactPageCount, isPdf, makeSamplePdf } from '../pdf/sample'
import type { BackendKind, CapabilityReport } from '../core/types'
import { probeSnmpConsumables, probeSnmpStatus, snmpHostFromUri, type SnmpProbeOptions } from '../backends/snmp'
import { pjlHostFromUri, probePjlStatus, probePjlSupply, type PjlProbeOptions } from '../backends/pjl'
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
    const [jobs, storage, backends] = await Promise.all([ctx.jobs.stats(), ctx.storage.stats(), ctx.backends.availability()])
    sendJson(res, 200, {
      jobs,
      storage,
      printers: ctx.printers.listAll().map((p) => ({ id: p.id, name: p.name, status: p.status, stats: p.stats, shared: p.shared })),
      backends,
    })
  })

  // ---------------------------------------------------------------- backends（阶段 2）

  router.get('/api/backends', async (ctx, _req, res) => {
    const backends = await ctx.backends.availability(true)
    ctx.bus.emit('backend:update', { backends })
    sendJson(res, 200, { backends })
  })

  // 手动触发系统打印机自动同步（windows/cups 枚举 → 幂等导入；幂等可重复调用）
  router.post('/api/backends/autosync', async (ctx, _req, res) => {
    const results = await ctx.autoSync.syncOnce()
    sendJson(res, 200, {
      results,
      summary: {
        imported: results.reduce((n, r) => n + r.imported, 0),
        updated: results.reduce((n, r) => n + r.updated, 0),
        vanished: results.reduce((n, r) => n + r.vanished.length, 0),
      },
    })
  })

  router.get('/api/backends/:kind/printers', async (ctx, _req, res, params) => {
    const backend = ctx.backends.get(params.kind as BackendKind)
    if (!backend) return sendError(res, 404, `后端不存在：${params.kind}（可用：${ctx.backends.kinds().join(', ')}）`)
    const available = await backend.available()
    let printers: Awaited<ReturnType<typeof backend.listPrinters>> = []
    if (available) {
      try {
        printers = await backend.listPrinters()
      } catch (err) {
        return sendError(res, 502, `后端列举失败：${err instanceof Error ? err.message : String(err)}`)
      }
    }
    sendJson(res, 200, { backend: params.kind, available, note: backend.availabilityNote, printers })
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
    let list = scope === 'admin' ? ctx.printers.listAll() : ctx.printers.listShared()
    // 正式运行模式不显示虚拟打印机（防御性隔离：正式环境本就不会创建；存量脏数据也不显示，但不删除）
    if (!ctx.hostInfo().devMode) list = list.filter((p) => !p.virtual)
    const withMeta = list.map((p) => ({ ...p, activeJobId: ctx.engine.activeJobId(p.id) ?? null }))
    sendJson(res, 200, { printers: withMeta })
  })

  router.get('/api/printers/:id', (ctx, _req, res, params) => {
    const printer = ctx.printers.get(params.id)
    if (!printer) return sendError(res, 404, `打印机不存在：${params.id}`)
    sendJson(res, 200, { printer: { ...printer, activeJobId: ctx.engine.activeJobId(printer.id) ?? null } })
  })

  router.post('/api/printers', (ctx, _req, res, _params, _query, body) => {
    // 虚拟打印机创建仅开发/测试模式可用（正式运行环境不创建/不显示虚拟打印机——产品红线）
    if (!ctx.hostInfo().devMode) {
      return sendError(res, 403, '正式运行模式禁止创建虚拟打印机（虚拟打印机仅限开发/测试模式：OPS_DEV_MODE=1）')
    }
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

  router.delete('/api/printers/:id', async (ctx, _req, res, params) => {
    const printer = ctx.printers.get(params.id)
    if (!printer) return sendError(res, 404, `打印机不存在：${params.id}`)
    if (!printer.virtual && printer.backend === 'mock') return sendError(res, 400, '仅虚拟打印机可以删除')
    // 导入的真实后端打印机（backend !== mock）可以删除；进行中任务先失败化
    ctx.engine.onPrinterRemoved(printer.id)
    for (const job of ctx.jobs.list({ printerId: printer.id })) {
      if (job.state === 'processing' || job.state === 'paused') {
        job.error = '打印机已被移除'
        ctx.jobs.setState(job, 'failed', '打印机已被移除，任务失败')
        void ctx.jobs.writeResult(job, 'failed', 'Printer removed')
      }
    }
    ctx.printers.remove(printer.id)
    void ctx.jobs.removeJobsWhere((j) => j.printerId === printer.id)
    sendJson(res, 200, { ok: true })
  })

  // ---------------------------------------------------------------- 真实打印机导入与能力刷新（阶段 2）

  router.post('/api/printers/import', async (ctx, _req, res, _params, _query, body) => {
    const input = parseJsonBody<{ backend?: string; key?: string; shared?: boolean; displayName?: string; test?: boolean }>(body)
    if (!input?.backend || !input?.key) return sendError(res, 400, '请求体必须包含 backend 与 key 字段')
    if (input.backend !== 'ipp' && input.backend !== 'cups' && input.backend !== 'windows') {
      return sendError(res, 400, 'backend 仅支持 ipp | cups | windows（mock 由内置虚拟打印机提供）')
    }
    const backend = ctx.backends.get(input.backend)
    if (!backend) return sendError(res, 404, `后端未装配：${input.backend}`)
    const available = await backend.available()
    if (!available) return sendError(res, 409, `后端 ${input.backend} 当前不可用：${backend.availabilityNote}`)
    const ref = await backend.getPrinter(String(input.key))
    if (!ref) return sendError(res, 404, `后端 ${input.backend} 中找不到打印机：${input.key}`)
    const printer = await ctx.printers.importFromBackend(backend, ref, {
      shared: input.shared ?? true,
      displayName: input.displayName ? String(input.displayName).slice(0, 80) : undefined,
      test: input.test ?? false,
    })
    sendJson(res, 201, { printer })
  })

  router.post('/api/printers/add-uri', async (ctx, _req, res, _params, _query, body) => {
    const input = parseJsonBody<{ uri?: string; shared?: boolean; displayName?: string }>(body)
    if (!input?.uri || !/^ipps?:\/\//i.test(String(input.uri))) {
      return sendError(res, 400, '请求体必须包含 uri 字段（ipps:// 暂不支持，请用 ipp://）')
    }
    const backend = ctx.backends.get('ipp')
    if (!backend) return sendError(res, 404, 'IPP 后端未装配')
    // 结构化访问 IPPPrinterBackend 的 addUri（避免窄化为接口类型）
    const ippBackend = backend as { addUri?: (uri: string, displayName?: string) => Promise<{ uri: string; displayName: string }> }
    if (typeof ippBackend.addUri !== 'function') return sendError(res, 500, 'IPP 后端不支持手动添加 URI')
    const entry = await ippBackend.addUri(String(input.uri).slice(0, 300), input.displayName ? String(input.displayName).slice(0, 80) : undefined)
    const ref = {
      key: entry.uri,
      displayName: entry.displayName,
      description: `手动添加的 IPP 打印机（${entry.uri}）`,
      uri: entry.uri,
    }
    const printer = await ctx.printers.importFromBackend(backend, ref, { shared: input.shared ?? true })
    sendJson(res, 201, { printer, uri: entry.uri })
  })

  router.post('/api/printers/:id/refresh-capabilities', async (ctx, _req, res, params) => {
    const printer = ctx.printers.get(params.id)
    if (!printer) return sendError(res, 404, `打印机不存在：${params.id}`)
    const backend = ctx.backends.get(printer.backend)
    if (!backend && printer.backend !== 'mock') return sendError(res, 404, `打印机后端未装配：${printer.backend}`)
    // 并行探测：后端属性 + SNMP 耗材/状态 + PJL over 9100（P4 Vendor Adapter；均失败只记 probe）
    const s = ctx.settings.get()
    const snmpCommunity = s.snmpCommunity || 'public'
    // SNMP 状态融合结果（PJL 融合需要知道 SNMP 是否已应用——通道优先级 IPP → SNMP → PJL）
    let snmpStatusApplied = false
    const snmpPromise = (async () => {
      const host = printer.backendUri ? snmpHostFromUri(printer.backendUri) : null
      if (!host) return [] as Array<{ source: 'SNMP'; report: CapabilityReport }>
      const opts: SnmpProbeOptions = { host, community: snmpCommunity, timeoutMs: 900, retries: 1 }
      const [supplies, status] = await Promise.all([probeSnmpConsumables(opts), probeSnmpStatus(opts)])
      // SNMP 状态融合：仅当 SNMP 读到硬条件（缺纸/卡纸/错误）且当前状态为 online/busy 时覆盖 ——
      // 已有更具体的 IPP 状态（paper-out/paper-jam/offline）优先保留；status=null 时不动
      if (status.status && (printer.status === 'online' || printer.status === 'busy')) {
        if (status.status !== 'online' && status.status !== 'busy') {
          ctx.printers.setStatus(printer, status.status, status.message)
          snmpStatusApplied = true
        } else if (printer.status === 'online' && status.status === 'busy') {
          ctx.printers.setStatus(printer, 'busy', status.message)
          snmpStatusApplied = true
        }
      }
      return [{ source: 'SNMP' as const, report: supplies.report }]
    })()
    // PJL over RAW 9100（P4）：默认关闭（VENDOR_PROTOCOLS.md 安全默认）；仅在 IPP/SNMP 未能确定时补充——
    // merge 层面由来源优先级保证（VENDOR_API < SNMP < IPP），状态融合层由 snmpStatusApplied 守卫
    const pjlPromise = (async () => {
      if (s.pjlProbeEnabled !== true) return [] as Array<{ source: 'VENDOR_API'; report: CapabilityReport }>
      const host = printer.backendUri ? pjlHostFromUri(printer.backendUri) : null
      if (!host) return [] as Array<{ source: 'VENDOR_API'; report: CapabilityReport }>
      const opts: PjlProbeOptions = { host, port: s.pjlPort ?? 9100, timeoutMs: 900 }
      const [supply, status] = await Promise.all([probePjlSupply(opts), probePjlStatus(opts)])
      // 通道优先级 IPP → SNMP → PJL：状态融合前先等 SNMP 决策完成（snmpPromise 内部不 reject，兜底 catch）
      await snmpPromise.catch(() => undefined)
      // 状态融合：仅当 SNMP 未应用且打印机处于 online/busy（已有更具体状态优先保留；PJL 是最后手段）
      if (status.ok && status.status && !snmpStatusApplied && (printer.status === 'online' || printer.status === 'busy')) {
        if (status.status !== 'online' && status.status !== 'busy') {
          ctx.printers.setStatus(printer, status.status, status.message ?? `PJL ${status.rawCode}`)
        } else if (printer.status === 'online' && status.status === 'busy') {
          ctx.printers.setStatus(printer, 'busy', status.message ?? 'PRINTING')
        }
      }
      // 状态回读无论耗材结果如何都记 probe（UI 展示该来源曾尝试 + 原始 CODE 诊断信息）
      const report = supply.report
      if (status.ok) {
        report.probes.push({ source: 'VENDOR_API', ok: true, durationMs: status.durationMs, detail: `PJL INFO STATUS CODE=${status.rawCode}（${status.display ?? ''}）`, at: new Date().toISOString() })
      }
      return [{ source: 'VENDOR_API' as const, report }]
    })()
    // 扁平化合并 extras（refreshCapabilities 收单一 Promise<Array>）
    const extrasPromise = (async () => {
      const [snmpList, pjlList] = await Promise.all([snmpPromise, pjlPromise])
      return [...snmpList, ...pjlList]
    })()
    const report = await ctx.printers.refreshCapabilities(printer, backend ?? null, extrasPromise)
    sendJson(res, 200, { printer, report })
  })

  // ---------------------------------------------------------------- Virtual IPP Server 控制（阶段 2）

  router.get('/api/vipp/printers', (ctx, _req, res) => {
    if (!ctx.vipp) return sendError(res, 409, 'Virtual IPP Server 未启用（OPS_VIPP_ENABLED=0）')
    sendJson(res, 200, { port: ctx.vipp.port, tlsPort: ctx.vipp.tlsActivePort, dataDir: ctx.vipp.dataDir, printers: ctx.vipp.list() })
  })

  router.post('/api/vipp/printers/:id/condition', async (ctx, _req, res, params, _query, body) => {
    if (!ctx.vipp) return sendError(res, 409, 'Virtual IPP Server 未启用（OPS_VIPP_ENABLED=0）')
    const input = parseJsonBody<{ condition?: string; message?: string }>(body)
    const condition = input?.condition
    const valid = ['none', 'online', 'media-needed', 'media-jam', 'offline']
    if (!condition || !valid.includes(condition)) {
      return sendError(res, 400, `condition 仅支持 ${valid.join(' | ')}`)
    }
    const normalized = condition === 'online' ? 'none' : (condition as 'none' | 'media-needed' | 'media-jam' | 'offline')
    const snapshot = await ctx.vipp.setCondition(params.id, normalized)
    if (!snapshot) return sendError(res, 404, `vipp 打印机不存在：${params.id}（可用：${ctx.vipp.getPrinterIds().join(', ')}）`)
    sendJson(res, 200, { ok: true, printer: snapshot, message: input?.message ?? `已注入条件 ${condition}` })
  })

  router.post('/api/vipp/printers/:id/speed', async (ctx, _req, res, params, _query, body) => {
    if (!ctx.vipp) return sendError(res, 409, 'Virtual IPP Server 未启用（OPS_VIPP_ENABLED=0）')
    const input = parseJsonBody<{ ppm?: number }>(body)
    if (!input?.ppm || Number.isNaN(Number(input.ppm))) return sendError(res, 400, '请求体必须包含 ppm（1–600）')
    const snapshot = await ctx.vipp.setPpm(params.id, Number(input.ppm))
    if (!snapshot) return sendError(res, 404, `vipp 打印机不存在：${params.id}`)
    sendJson(res, 200, { ok: true, printer: snapshot })
  })

  // ---------------------------------------------------------------- Virtual PJL Printer 控制（P4 · RAW 9100 仿真）

  /** 当前虚拟 PJL 设备快照（状态/原始字节计数/连接数） */
  router.get('/api/vpjl/state', (ctx, _req, res) => {
    if (!ctx.vpjl) return sendError(res, 409, 'Virtual PJL Printer 未启用（OPS_VPJL_ENABLED=0）')
    sendJson(res, 200, { state: ctx.vpjl.state() })
  })

  /** 注入调试状态（对齐 vipp.setCondition 的调试用途；配合打印机页「刷新能力」验证 PJL 状态/耗材回读） */
  router.post('/api/vpjl/condition', (ctx, _req, res, _params, _query, body) => {
    if (!ctx.vpjl) return sendError(res, 409, 'Virtual PJL Printer 未启用（OPS_VPJL_ENABLED=0）')
    const input = parseJsonBody<{ condition?: string }>(body)
    const condition = input?.condition
    if (!condition) return sendError(res, 400, '请求体必须包含 condition')
    const state = ctx.vpjl.setCondition(condition)
    if (!state) {
      return sendError(res, 400, 'condition 仅支持 ready | busy | warmup | offline | paper-out | paper-jam | door-open | toner-low | toner-empty')
    }
    sendJson(res, 200, { ok: true, state, message: `已注入 PJL 状态：${condition}` })
  })

  // ---------------------------------------------------------------- 扫描（P3 · eSCL）

  router.get('/api/scan/devices', async (ctx, _req, res) => {
    const devices = await ctx.scan.listDevices(ctx.vscan)
    sendJson(res, 200, { devices })
  })

  /** mDNS 实时扫描 _uscan._tcp（组播不可用返回空 + 说明，不算错误） */
  router.post('/api/scan/devices/scan-mdns', async (ctx, _req, res) => {
    if (!ctx.mdns.isAvailable()) {
      return sendJson(res, 200, { devices: [], available: false, note: ctx.mdns.note() || 'mDNS 不可用（组播 socket 未绑定）' })
    }
    const devices = await ctx.scan.mdnsScan(ctx.vscan)
    sendJson(res, 200, { devices, available: true, note: ctx.mdns.note() })
  })

  router.post('/api/scan/devices', async (ctx, _req, res, _params, _query, body) => {
    const input = parseJsonBody<{ baseUrl?: string; name?: string }>(body)
    if (!input?.baseUrl) return sendError(res, 400, '请求体必须包含 baseUrl 字段（如 http://192.168.1.50:8080）')
    try {
      const device = await ctx.scan.addDevice(String(input.baseUrl).slice(0, 300), input.name ? String(input.name).slice(0, 80) : undefined)
      sendJson(res, 201, { device })
    } catch (err) {
      // 探活失败（连接拒绝 / 超时 / 非 eSCL 端点）→ 400
      sendError(res, 400, `扫描仪探活失败：${err instanceof Error ? err.message : String(err)}`)
    }
  })

  router.delete('/api/scan/devices/:id', async (ctx, _req, res, params) => {
    const devices = await ctx.scan.listDevices(ctx.vscan)
    const target = devices.find((d) => d.id === params.id)
    if (target && target.source !== 'manual') return sendError(res, 400, `仅手动添加的扫描设备可删除（${params.id} 来源为 ${target.source}）`)
    const ok = await ctx.scan.removeDevice(params.id)
    if (!ok) return sendError(res, 404, `扫描设备不存在：${params.id}`)
    sendJson(res, 200, { ok: true })
  })

  router.post('/api/scan/jobs', async (ctx, _req, res, _params, _query, body) => {
    const input = parseJsonBody<{ deviceId?: string; format?: string; dpi?: number; colorMode?: string; inputSource?: string; duplex?: boolean }>(body)
    if (!input?.deviceId) return sendError(res, 400, '请求体必须包含 deviceId 字段')
    const devices = await ctx.scan.listDevices(ctx.vscan)
    const device = devices.find((d) => d.id === input.deviceId)
    if (!device) return sendError(res, 404, `扫描设备不存在：${input.deviceId}`)
    const dpi = Number(input.dpi ?? 300) || 300
    if (!Number.isFinite(dpi) || dpi < 75 || dpi > 1200) return sendError(res, 400, `dpi 必须在 75–1200 之间（实际 ${String(input.dpi ?? '未填')}）`)
    const format = input.format === 'application/pdf' ? ('application/pdf' as const) : ('image/png' as const)
    const colorMode = input.colorMode === 'Grayscale' ? ('Grayscale' as const) : ('RGB' as const)
    const inputSource = input.inputSource === 'Feeder' ? ('Feeder' as const) : ('Platen' as const)
    const duplex = input.duplex === true
    // 双面语义校验（路由层先行拦截：Platen + duplex 组合无意义）
    if (duplex && inputSource !== 'Feeder') {
      return sendError(res, 400, '双面扫描仅支持送稿器（Feeder）：平板无法双面，请关闭双面或切换输稿器')
    }
    try {
      const job = await ctx.scan.startScan(device, { format, dpi, colorMode, inputSource, duplex })
      sendJson(res, 202, { job })
    } catch (err) {
      sendError(res, 400, `创建扫描任务失败：${err instanceof Error ? err.message : String(err)}`)
    }
  })

  router.get('/api/scan/jobs', (ctx, _req, res) => {
    sendJson(res, 200, { jobs: ctx.scan.listJobs() })
  })

  router.get('/api/scan/jobs/:id', (ctx, _req, res, params) => {
    const job = ctx.scan.getJob(params.id)
    if (!job) return sendError(res, 404, `扫描任务不存在：${params.id}`)
    sendJson(res, 200, { job })
  })

  /** 取某页 PNG（二进制；参照 /api/jobs/:id/document 的直写模式） */
  router.get('/api/scan/jobs/:id/image', async (ctx, _req, res, params, query) => {
    const job = ctx.scan.getJob(params.id)
    if (!job) return sendError(res, 404, `扫描任务不存在：${params.id}`)
    const page = Math.max(1, Number(query.get('page') ?? 1) || 1)
    const bytes = await ctx.scan.getJobImageBytes(job, page)
    if (!bytes) return sendError(res, 404, `无图像：任务 ${params.id} 第 ${page} 页（已完成 ${job.pagesDone} 页）`)
    res.writeHead(200, {
      'content-type': 'image/png',
      'content-disposition': `attachment; filename="${job.id}-page-${page}.png"`,
      'cache-control': 'no-store',
    })
    res.end(bytes)
  })

  router.post('/api/scan/jobs/:id/cancel', async (ctx, _req, res, params) => {
    try {
      const job = await ctx.scan.cancelJob(params.id)
      sendJson(res, 200, { job })
    } catch (err) {
      sendError(res, 404, err instanceof Error ? err.message : String(err))
    }
  })

  /** 按需导出 PDF（P3.5）：completed 任务多页 PNG → A4 合成 PDF（幂等缓存） */
  router.post('/api/scan/jobs/:id/export-pdf', async (ctx, _req, res, params) => {
    try {
      const job = await ctx.scan.exportJobPdf(params.id)
      sendJson(res, 200, { job })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      sendError(res, message.includes('不存在') ? 404 : 400, message)
    }
  })

  /** 下载导出的 PDF（二进制；未导出 404） */
  router.get('/api/scan/jobs/:id/pdf', async (ctx, _req, res, params) => {
    const job = ctx.scan.getJob(params.id)
    if (!job) return sendError(res, 404, `扫描任务不存在：${params.id}`)
    const bytes = await ctx.scan.getJobPdfBytes(job)
    if (!bytes) return sendError(res, 404, `任务 ${params.id} 尚未导出 PDF（先调用 POST /api/scan/jobs/${params.id}/export-pdf）`)
    res.writeHead(200, {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="ops-scan-${job.id}.pdf"`,
      'cache-control': 'no-store',
    })
    res.end(bytes)
  })

  router.delete('/api/scan/jobs/:id', async (ctx, _req, res, params) => {
    const ok = await ctx.scan.removeJob(params.id)
    if (!ok) return sendError(res, 404, `扫描任务不存在：${params.id}`)
    sendJson(res, 200, { ok: true })
  })

  // ---------------------------------------------------------------- mDNS 发现（阶段 2）

  router.get('/api/discovery/mdns', (ctx, _req, res) => {
    sendJson(res, 200, { ...ctx.mdns.lastResults(), available: ctx.mdns.isAvailable() })
  })

  router.post('/api/discovery/mdns/scan', async (ctx, _req, res) => {
    if (!ctx.mdns.isAvailable()) {
      return sendJson(res, 200, { printers: [], available: false, note: ctx.mdns.note() || 'mDNS 不可用（组播 socket 未绑定）' })
    }
    const printers = await ctx.mdns.scan()
    sendJson(res, 200, { printers, available: true, note: ctx.mdns.note() })
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

  router.post('/api/jobs/:id/cancel', async (ctx, _req, res, params) => {
    const job = ctx.jobs.get(params.id)
    if (!job) return sendError(res, 404, `任务不存在：${params.id}`)
    const printer = ctx.printers.get(job.printerId)
    // 真实后端打印机 → 转发到 backend.cancelJob（IPP Cancel-Job）；虚拟打印机 → 引擎取消
    const result = printer && printer.backend !== 'mock' ? await ctx.runner.cancel(job) : ctx.engine.cancelJob(job)
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

  // ---------------------------------------------------------------- console auth（P2 安全轮：管理面令牌）

  /** 登录校验（公网白名单）：验证令牌 → 200 返回 HostInfo；失败 401 */
  router.post('/api/console/auth', (ctx, req, res, _params, query, body) => {
    const input = parseJsonBody<{ token?: string }>(body)
    let token = input?.token ?? null
    if (!token) token = extractConsoleToken(req, query)
    if (!ctx.settings.verifyConsoleToken(token)) {
      // 登录端点本身的 401 不携带 console_auth_required 标记（避免触发前端再次弹锁）
      return sendError(res, 401, '访问令牌无效或缺失')
    }
    sendJson(res, 200, { ok: true, info: ctx.hostInfo() })
  })

  /** 启用（公网白名单，收紧永远允许）：总是生成全新令牌；响应返回完整值 + 落盘 data/console-token.txt 防锁定 */
  router.post('/api/console/enable', async (ctx, _req, res) => {
    const token = await ctx.settings.enableConsoleAuth()
    ctx.log.record({ type: 'security', topic: 'console-auth', message: '控制台鉴权已启用：REST/WS 管理面需要访问令牌（协议端口 3061/3065 不受影响）' })
    ctx.bus.emit('host:update', { info: ctx.hostInfo() })
    sendJson(res, 200, { ok: true, token, settings: ctx.settings.get() })
  })

  /** 关闭（需有效令牌）：放开管理面 */
  router.post('/api/console/disable', async (ctx, req, res, _params, query) => {
    if (!consoleAuthGate(ctx, req, res, query)) return
    await ctx.settings.disableConsoleAuth()
    ctx.log.record({ type: 'security', topic: 'console-auth', message: '控制台鉴权已关闭：局域网管理面恢复开放' })
    ctx.bus.emit('host:update', { info: ctx.hostInfo() })
    sendJson(res, 200, { ok: true, settings: ctx.settings.get() })
  })

  /** 重生成令牌（需有效令牌）：旧值立即失效，WS 存量连接将被断开重连 */
  router.post('/api/console/token/regenerate', async (ctx, req, res, _params, query) => {
    if (!consoleAuthGate(ctx, req, res, query)) return
    const token = await ctx.settings.regenerateConsoleToken()
    ctx.log.record({ type: 'security', topic: 'console-auth', message: '控制台访问令牌已重新生成：此前保存的令牌全部失效' })
    ctx.bus.emit('host:update', { info: ctx.hostInfo() })
    sendJson(res, 200, { ok: true, token })
  })

  router.patch('/api/settings', async (ctx, _req, res, _params, _query, body) => {
    const patch = parseJsonBody<{ hostName?: string; securityMode?: 'open' | 'pairing'; snmpCommunity?: string }>(body)
    if (!patch) return sendError(res, 400, '请求体不是合法 JSON')
    if (patch.securityMode && patch.securityMode !== 'open' && patch.securityMode !== 'pairing') {
      return sendError(res, 400, 'securityMode 仅支持 open | pairing')
    }
    if (patch.hostName !== undefined && (typeof patch.hostName !== 'string' || patch.hostName.trim() === '')) {
      return sendError(res, 400, 'hostName 需为非空字符串')
    }
    if (patch.snmpCommunity !== undefined) {
      const c = String(patch.snmpCommunity)
      if (!/^\S{1,64}$/.test(c)) return sendError(res, 400, 'snmpCommunity 需为 1-64 个非空白字符')
    }
    if (patch.pjlProbeEnabled !== undefined && typeof patch.pjlProbeEnabled !== 'boolean') {
      return sendError(res, 400, 'pjlProbeEnabled 需为布尔值')
    }
    if (patch.pjlPort !== undefined) {
      const p = Number(patch.pjlPort)
      if (!Number.isInteger(p) || p < 1 || p > 65535) return sendError(res, 400, 'pjlPort 需为 1-65535 整数（真实设备通用 9100）')
    }
    const settings = await ctx.settings.patch({
      hostName: patch.hostName?.slice(0, 80),
      securityMode: patch.securityMode,
      snmpCommunity: patch.snmpCommunity,
      pjlProbeEnabled: patch.pjlProbeEnabled,
      pjlPort: patch.pjlPort,
    })
    ctx.log.record({
      type: 'security',
      topic: 'settings',
      message: `Host 设置已更新（安全模式：${settings.securityMode}${patch.snmpCommunity !== undefined ? '，SNMP community 已更新' : ''}${patch.pjlProbeEnabled !== undefined ? `，PJL 探测 ${settings.pjlProbeEnabled === true ? '已启用' : '已关闭'}` : ''}${patch.pjlPort !== undefined ? `（端口 ${settings.pjlPort ?? 9100}）` : ''}）`,
    })
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
    // 自测依赖虚拟打印机/仿真设备（测试专用模块）——正式运行模式不可用（与正式产品隔离红线）
    if (!ctx.hostInfo().devMode) {
      return sendError(res, 403, '自动化自测仅开发/测试模式可用（依赖虚拟打印机；正式模式请用真实打印机手动验证）')
    }
    const input = parseJsonBody<{ ids?: string[] }>(body)
    if (ctx.selfTest.isRunning()) return sendError(res, 409, '已有测试运行中，请等待完成')
    const run = ctx.selfTest.start(input?.ids)
    sendJson(res, 202, { runId: run.runId })
  })

  router.get('/api/tests/runs', async (ctx, _req, res) => {
    const ids = await ctx.storage.listTestRunIds()
    const runs: unknown[] = []
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
