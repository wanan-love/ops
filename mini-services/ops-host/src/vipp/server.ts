import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createTlsServer, type Server as TlsServer } from 'node:https'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { EventBus } from '../core/eventbus'
import type { VippPrinterSnapshot } from '../core/types'
import { exactPageCount } from '../pdf/sample'
import {
  attr,
  decodeIppMessage,
  encodeIppMessage,
  findAttr,
  attrInt,
  attrStr,
  attrStrs,
  isJobGroup,
  GROUP_OPERATION,
  GROUP_PRINTER,
  GROUP_JOB_RESPONSE,
  OP_PRINT_JOB,
  OP_CANCEL_JOB,
  OP_GET_JOB_ATTRIBUTES,
  OP_GET_JOBS,
  OP_GET_PRINTER_ATTRIBUTES,
  OP_VALIDATE_JOB,
  STATUS_OK,
  STATUS_CLIENT_ERROR_BAD_REQUEST,
  STATUS_CLIENT_ERROR_NOT_FOUND,
  STATUS_CLIENT_ERROR_NOT_POSSIBLE,
  STATUS_SERVER_ERROR,
  STATUS_SERVER_ERROR_OPERATION_NOT_SUPPORTED,
} from '../backends/ipp/protocol'
import type { EncAttr, EncGroup, IppGroup, IppMessage } from '../backends/ipp/protocol'

/**
 * Virtual IPP Server — 自建 IPP 服务端（端口 3061）。
 *
 * 目的：在无 CUPS / 无实体打印机的沙箱中，让「真实 IPP 二进制协议链路」可以端到端验证：
 *   Host BackendJobRunner → IPP Client（RFC 8010 编码）→ HTTP POST application/ipp
 *     → 本服务（解码 → 调度 → 响应编码）→ 任务状态轮询 → Cancel。
 *
 * 实现的操作：
 *   - Get-Printer-Attributes (0x000B)
 *   - Print-Job (0x0002)
 *   - Get-Job-Attributes (0x0009)
 *   - Get-Jobs (0x000A, which-jobs=not-completed/completed/all)
 *   - Cancel-Job (0x0008)
 *   - Validate-Job (0x000C)
 *
 * 内置 4 个能力档案（专门用于测试「能力缺失的打印机」）：
 *   - vipp-full    完整能力 + marker-levels（耗材可见，IPP 来源）
 *   - vipp-basic   有 color，但无 sides-supported / 无 marker-*（双面/耗材 UNKNOWN）
 *   - vipp-mono    color-supported=false、无 marker、media 仅 A4
 *   - vipp-minimal 只暴露 printer-state + printer-name（最吝啬的 IPP 设备）
 *
 * 每台打印机有独立轻量引擎：FIFO、按可调 ppm 推进、任务落盘
 *   data/virtual-ipp/<printer-id>/jobs/<uuid>/{document.pdf, job.json}
 *   data/virtual-ipp/<printer-id>/printer.json（nextJobId / condition / ppm）
 */

const TICK_MS = 250

export type VippJobState = 'pending' | 'processing' | 'processing-stopped' | 'canceled' | 'aborted' | 'completed'
export type VippCondition = 'none' | 'media-needed' | 'media-jam' | 'offline'

/** vipp 任务内部状态 → IPP job-state (RFC 8011) */
const JOB_STATE_TO_IPP: Record<VippJobState, number> = {
  pending: 3,
  processing: 5,
  'processing-stopped': 6,
  canceled: 7,
  aborted: 8,
  completed: 9,
}

const JOB_STATE_REASONS: Record<VippJobState, string> = {
  pending: 'job-pending',
  processing: 'job-processing',
  'processing-stopped': 'job-processing-stopped',
  canceled: 'job-canceled-by-user',
  aborted: 'job-aborted-by-system',
  completed: 'job-completed-successfully',
}

/** 条件 → IPP printer-state-reasons 关键字 */
const CONDITION_REASONS: Record<VippCondition, string[]> = {
  none: ['none'],
  'media-needed': ['media-needed'],
  'media-jam': ['media-jam'],
  offline: ['shutdown'],
}

export interface VippJobRecord {
  jobId: number
  uuid: string
  jobName: string
  userName: string
  format: string
  copies: number
  sides: string
  media: string
  colorMode: string
  quality: number
  sizeBytes: number
  /** 总印数（页 × 份数） */
  impressionsTotal: number
  impressionsCompleted: number
  sheetsCompleted: number
  state: VippJobState
  submittedAt: string
  startedAt: string | null
  finishedAt: string | null
  error?: string
}

interface VippProfile {
  id: string
  label: string
  displayName: string
  description: string
  location: string
  makeAndModel: string
  /** undefined = 该属性不暴露（能力 UNKNOWN 的根源：属性缺失 ≠ 不支持） */
  colorSupported?: boolean
  sidesSupported?: string[]
  mediaSupported?: string[]
  copiesRange?: [number, number]
  resolutionDpi?: number
  ppm: number
  markerLevels?: number[]
  markerTypes?: string[]
  markerNames?: string[]
  markerColors?: string[]
}

function buildProfiles(defaultPpm: number): VippProfile[] {
  return [
    {
      id: 'vipp-full',
      label: 'Full',
      displayName: 'OPS Virtual IPP Full',
      description: '完整能力档案：彩色/双面/多介质/1200dpi + 4 色碳粉（marker-levels 可见）',
      location: 'Virtual IPP 机房 3061',
      makeAndModel: 'OpenPrintShare Virtual IPP Printer (Full)',
      colorSupported: true,
      sidesSupported: ['one-sided', 'two-sided-long-edge', 'two-sided-short-edge'],
      mediaSupported: ['A4', 'Letter'],
      copiesRange: [1, 99],
      resolutionDpi: 1200,
      ppm: defaultPpm,
      markerLevels: [82, 64, 91, 77],
      markerTypes: ['toner', 'toner', 'toner', 'toner'],
      markerNames: ['Cyan Toner', 'Magenta Toner', 'Yellow Toner', 'Black Toner'],
      markerColors: ['#00FFFF', '#FF00FF', '#FFFF00', '#000000'],
    },
    {
      id: 'vipp-basic',
      label: 'Basic',
      displayName: 'OPS Virtual IPP Basic',
      description: '能力吝啬档案：有 color-supported，但无 sides-supported（双面 UNKNOWN）、无 marker-*（耗材 UNKNOWN）',
      location: 'Virtual IPP 机房 3061',
      makeAndModel: 'OpenPrintShare Virtual IPP Printer (Basic)',
      colorSupported: true,
      // 刻意不暴露 sidesSupported / marker* —— 测试“属性缺失 ≠ 不支持”
      mediaSupported: ['A4', 'Letter'],
      copiesRange: [1, 50],
      resolutionDpi: 600,
      ppm: defaultPpm,
    },
    {
      id: 'vipp-mono',
      label: 'Mono',
      displayName: 'OPS Virtual IPP Mono',
      description: '单色档案：color-supported=false（明确不支持彩色）、无 marker、media 仅 A4',
      location: 'Virtual IPP 机房 3061',
      makeAndModel: 'OpenPrintShare Virtual IPP Printer (Mono)',
      colorSupported: false,
      sidesSupported: ['one-sided'],
      mediaSupported: ['A4'],
      copiesRange: [1, 20],
      resolutionDpi: 600,
      ppm: defaultPpm,
    },
    {
      id: 'vipp-minimal',
      label: 'Minimal',
      displayName: 'OPS Virtual IPP Minimal',
      description: '最吝啬档案：仅暴露 printer-state + printer-name，其余能力全部 UNKNOWN',
      location: 'Virtual IPP 机房 3061',
      makeAndModel: 'OpenPrintShare Virtual IPP Printer (Minimal)',
      // 仅 printer-state / printer-name
      ppm: defaultPpm,
    },
  ]
}

/** 单台 vipp 打印机（数据 + 轻量引擎状态） */
class VippPrinter {
  readonly profile: VippProfile
  readonly dataDir: string
  state: 'idle' | 'processing' | 'stopped' = 'idle'
  condition: VippCondition = 'none'
  ppm: number
  completedJobs = 0
  nextJobId = 1
  queue: VippJobRecord[] = []
  active: VippJobRecord | null = null
  readonly jobs = new Map<string, VippJobRecord>()
  private lastJobPersistAt = 0

  constructor(profile: VippProfile, dataDir: string, private readonly serverStartedAt: number) {
    this.profile = profile
    this.dataDir = dataDir
    this.ppm = profile.ppm
  }

  get printerDir(): string {
    return join(this.dataDir, this.profile.id)
  }

  jobDir(uuid: string): string {
    return join(this.printerDir, 'jobs', uuid)
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(join(this.printerDir, 'printer.json'), 'utf8')
      const saved = JSON.parse(raw) as { nextJobId?: number; condition?: VippCondition; ppm?: number; completedJobs?: number }
      this.nextJobId = saved.nextJobId ?? 1
      this.condition = saved.condition ?? 'none'
      this.ppm = saved.ppm ?? this.profile.ppm
      this.completedJobs = saved.completedJobs ?? 0
    } catch {
      /* 首次运行 */
    }
    // 恢复历史任务
    let jobUuids: string[] = []
    try {
      jobUuids = await fs.readdir(join(this.printerDir, 'jobs'))
    } catch {
      return
    }
    for (const uuid of jobUuids) {
      try {
        const raw = await fs.readFile(join(this.jobDir(uuid), 'job.json'), 'utf8')
        const job = JSON.parse(raw) as VippJobRecord
        if (job.uuid === uuid) {
          this.jobs.set(uuid, job)
          if (job.state === 'pending') this.queue.push(job)
          else if (job.state === 'processing' || job.state === 'processing-stopped') this.active = job
        }
      } catch {
        /* 跳过损坏记录 */
      }
    }
    this.recomputeState()
    if (this.condition !== 'none') {
      this.state = 'stopped'
      if (this.active && this.active.state === 'processing') this.active.state = 'processing-stopped'
    }
  }

  async persistPrinter(): Promise<void> {
    await fs.mkdir(this.printerDir, { recursive: true })
    const data = { nextJobId: this.nextJobId, condition: this.condition, ppm: this.ppm, completedJobs: this.completedJobs }
    const target = join(this.printerDir, 'printer.json')
    const tmp = `${target}.${Date.now()}-${Math.floor(Math.random() * 1e6)}.tmp`
    await fs.writeFile(tmp, JSON.stringify(data, null, 2))
    await fs.rename(tmp, target)
  }

  async persistJob(job: VippJobRecord, force = false): Promise<void> {
    const now = Date.now()
    if (!force && now - this.lastJobPersistAt < 400) return
    this.lastJobPersistAt = now
    const dir = this.jobDir(job.uuid)
    await fs.mkdir(dir, { recursive: true })
    const target = join(dir, 'job.json')
    const tmp = `${target}.${Date.now()}-${Math.floor(Math.random() * 1e6)}.tmp`
    await fs.writeFile(tmp, JSON.stringify(job, null, 2))
    await fs.rename(tmp, target)
  }

  async setCondition(condition: VippCondition): Promise<void> {
    this.condition = condition
    if (condition === 'none') {
      if (this.active && this.active.state === 'processing-stopped') this.active.state = 'processing'
    } else {
      if (this.active && this.active.state === 'processing') {
        this.active.state = 'processing-stopped'
        await this.persistJob(this.active, true)
      }
    }
    this.recomputeState()
    await this.persistPrinter()
  }

  async setPpm(ppm: number): Promise<void> {
    this.ppm = Math.max(1, Math.min(600, Math.round(ppm)))
    await this.persistPrinter()
  }

  findJob(jobId: number): VippJobRecord | null {
    for (const job of this.jobs.values()) {
      if (job.jobId === jobId) return job
    }
    return null
  }

  get queuedJobCount(): number {
    return this.queue.length + (this.active ? 1 : 0)
  }

  recomputeState(): void {
    if (this.condition !== 'none') {
      this.state = 'stopped'
      return
    }
    this.state = this.active || this.queue.length > 0 ? 'processing' : 'idle'
  }

  upTimeSec(): number {
    return Math.floor((Date.now() - this.serverStartedAt) / 1000)
  }

  snapshot(): VippPrinterSnapshot {
    return {
      id: this.profile.id,
      name: this.profile.displayName,
      profile: this.profile.label,
      state: this.state,
      stateReasons: CONDITION_REASONS[this.condition],
      queuedJobs: this.queuedJobCount,
      activeJobId: this.active?.jobId ?? null,
      completedJobs: this.completedJobs,
      ppm: this.ppm,
      condition: this.condition,
      updatedAt: new Date().toISOString(),
    }
  }
}

export interface VippServerOptions {
  port: number
  dataDir: string
  /** 每台 vipp 打印机的标称速度（默认 60ppm 便于测试；OPS_VIPP_PPM 可调） */
  defaultPpm?: number
  bus?: EventBus
  /** ipps://（TLS）监听端口；null/undefined = 不启用。证书缺失时自动用 openssl 生成自签证书（失败降级跳过） */
  tlsPort?: number | null
}

export class VirtualIppServer {
  private readonly printers = new Map<string, VippPrinter>()
  private server: Server | null = null
  private tlsServer: TlsServer | null = null
  private tlsPortWanted: number | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private startedAt = 0
  readonly port: number
  readonly dataDir: string

  /** 实际监听中的 TLS 端口（null = 未启用/降级）—— 供 mDNS 通告与 API 暴露 */
  get tlsActivePort(): number | null {
    return this.tlsServer ? this.tlsPortWanted : null
  }

  constructor(private readonly opts: VippServerOptions) {
    this.port = opts.port
    this.dataDir = opts.dataDir
    this.tlsPortWanted = opts.tlsPort ?? null
    const ppm = opts.defaultPpm ?? 60
    for (const profile of buildProfiles(ppm)) {
      this.printers.set(profile.id, new VippPrinter(profile, opts.dataDir, Date.now()))
    }
  }

  async start(): Promise<void> {
    this.startedAt = Date.now()
    for (const printer of this.printers.values()) {
      await printer.load()
    }
    await new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.handle(req, res).catch((err) => {
          console.error('[vipp] request handler error:', err)
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: String(err) }))
          } else {
            res.end()
          }
        })
      })
      server.once('error', reject)
      server.listen(this.port, () => {
        server.off('error', reject)
        resolve()
      })
      this.server = server
    })
    if (this.tlsPortWanted !== null) {
      await this.startTls(this.tlsPortWanted)
    }
    this.timer = setInterval(() => this.tick(), TICK_MS)
    console.log(`[vipp] Virtual IPP Server listening on :${this.port}（data=${this.dataDir}，${this.printers.size} 台虚拟 IPP 打印机）`)
  }

  /** ipps:// TLS 监听（自签开发证书；首次启动用 openssl 生成，环境无 openssl 或端口占用则降级跳过） */
  private async startTls(port: number): Promise<void> {
    const certDir = join(this.dataDir, 'tls')
    const certPath = join(certDir, 'dev-cert.pem')
    const keyPath = join(certDir, 'dev-key.pem')
    try {
      await fs.mkdir(certDir, { recursive: true })
      const certExists = await fs.readFile(certPath).then(
        () => true,
        () => false,
      )
      const keyExists = await fs.readFile(keyPath).then(
        () => true,
        () => false,
      )
      if (!certExists || !keyExists) {
        // 自签名开发证书（仅 Virtual IPP 测试用途；CN=localhost + 回环 SAN）
        await new Promise<void>((resolve, reject) => {
          execFile(
            'openssl',
            [
              'req', '-x509', '-newkey', 'rsa:2048',
              '-keyout', keyPath, '-out', certPath,
              '-days', '3650', '-nodes',
              '-subj', '/CN=OPS Virtual IPP Dev',
              '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1',
            ],
            { timeout: 20000 },
            (err) => (err ? reject(err) : resolve()),
          )
        })
      }
      const [cert, key] = await Promise.all([fs.readFile(certPath), fs.readFile(keyPath)])
      await new Promise<void>((resolve, reject) => {
        const server = createTlsServer({ cert, key }, (req, res) => {
          void this.handle(req, res).catch((err) => {
            console.error('[vipp-tls] request handler error:', err)
            if (!res.headersSent) {
              res.writeHead(500, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ error: String(err) }))
            } else {
              res.end()
            }
          })
        })
        server.once('error', reject)
        server.listen(port, () => {
          server.off('error', reject)
          resolve()
        })
        this.tlsServer = server
      })
      console.log(`[vipp] Virtual IPP Server TLS (ipps) listening on :${port}（自签名开发证书，仅测试用途）`)
    } catch (err) {
      // 证书生成/监听失败 → 降级：不监听 TLS，明文 3061 功能不受影响
      this.tlsServer = null
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`[vipp] TLS 监听未启用（降级运行，ipps 不可用）：${message}`)
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.server?.close()
    this.tlsServer?.close()
    this.tlsServer = null
    this.server = null
  }

  baseUri(): string {
    return `ipp://localhost:${this.port}`
  }

  printerUri(id: string): string {
    return `ipp://localhost:${this.port}/printers/${id}`
  }

  list(): VippPrinterSnapshot[] {
    return [...this.printers.values()].map((p) => p.snapshot())
  }

  getPrinterIds(): string[] {
    return [...this.printers.keys()]
  }

  /** 测试辅助：读取某台 vipp 打印机的任务状态 */
  jobState(printerId: string, jobId: number): VippJobState | null {
    return this.printers.get(printerId)?.findJob(jobId)?.state ?? null
  }

  /** 注入/清除打印机条件（演示 printer-state-reasons：media-needed 等） */
  async setCondition(printerId: string, condition: VippCondition): Promise<VippPrinterSnapshot | null> {
    const printer = this.printers.get(printerId)
    if (!printer) return null
    await printer.setCondition(condition)
    const snapshot = printer.snapshot()
    this.opts.bus?.emit('vipp:update', { printer: snapshot })
    console.log(`[vipp] ${printerId} condition → ${condition}（state=${snapshot.state}，reasons=${snapshot.stateReasons.join(',')}）`)
    return snapshot
  }

  async setPpm(printerId: string, ppm: number): Promise<VippPrinterSnapshot | null> {
    const printer = this.printers.get(printerId)
    if (!printer) return null
    await printer.setPpm(ppm)
    const snapshot = printer.snapshot()
    this.opts.bus?.emit('vipp:update', { printer: snapshot })
    return snapshot
  }

  // ---------------------------------------------------------------- HTTP

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    if (req.method === 'GET') {
      if (url.pathname === '/' || url.pathname === '/healthz') {
        sendJson(res, 200, {
          service: 'ops-virtual-ipp-server',
          port: this.port,
          uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
          printers: this.list(),
        })
        return
      }
      if (url.pathname === '/printers') {
        sendJson(res, 200, { printers: this.list() })
        return
      }
      sendJson(res, 404, { error: `未找到路由 GET ${url.pathname}` })
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: '仅支持 POST（IPP 请求）' })
      return
    }
    // IPP 请求（content-type: application/ipp）
    const body = await readBody(req)
    let response: Uint8Array
    try {
      response = await this.dispatchIpp(body, url.pathname)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[vipp] IPP dispatch error:', message)
      response = encodeIppMessage({
        code: STATUS_SERVER_ERROR,
        requestId: safeRequestId(body),
        groups: [errorOperationGroup(message)],
      })
    }
    res.writeHead(200, { 'content-type': 'application/ipp' })
    res.end(Buffer.from(response))
  }

  /** IPP 请求分发（Print-Job / Cancel-Job 涉及落盘 → async） */
  private async dispatchIpp(body: Uint8Array, urlPath: string): Promise<Uint8Array> {
    const msg = decodeIppMessage(body)
    const operation = msg.code
    // 目标打印机：优先 URL path（/printers/<id>），否则 printer-uri 属性
    const printerUriAttr = attrStr(findAttr(msg, 'printer-uri'))
    let target = resolvePrinterId(urlPath)
    if (!target && printerUriAttr) {
      try {
        target = resolvePrinterId(new URL(printerUriAttr, 'http://localhost').pathname)
      } catch {
        /* printer-uri 非法 → target 保持 null */
      }
    }

    switch (operation) {
      case OP_GET_PRINTER_ATTRIBUTES:
        return this.handleGetPrinterAttributes(msg, target)
      case OP_PRINT_JOB:
        return await this.handlePrintJob(msg, target)
      case OP_GET_JOB_ATTRIBUTES:
        return this.handleGetJobAttributes(msg, target)
      case OP_GET_JOBS:
        return this.handleGetJobs(msg, target)
      case OP_CANCEL_JOB:
        return await this.handleCancelJob(msg, target)
      case OP_VALIDATE_JOB:
        return this.handleValidateJob(msg, target)
      default:
        return encodeIppMessage({
          code: STATUS_SERVER_ERROR_OPERATION_NOT_SUPPORTED,
          requestId: msg.requestId,
          groups: [errorOperationGroup(`不支持的操作 0x${operation.toString(16).padStart(4, '0')}`)],
        })
    }
  }

  private requirePrinter(target: string | null, requestId: number): { printer: VippPrinter } | { response: Uint8Array } {
    const printer = target ? this.printers.get(target) : undefined
    if (!printer) {
      return {
        response: encodeIppMessage({
          code: STATUS_CLIENT_ERROR_NOT_FOUND,
          requestId,
          groups: [errorOperationGroup(`打印机不存在：${target ?? '(未指定)'}（可用：${[...this.printers.keys()].join(', ')}）`)],
        }),
      }
    }
    return { printer }
  }

  // ---------------- Get-Printer-Attributes (0x000B)

  private handleGetPrinterAttributes(msg: IppMessage, target: string | null): Uint8Array {
    const found = this.requirePrinter(target, msg.requestId)
    if ('response' in found) return found.response
    const printer = found.printer
    const requested = attrStrs(findAttr(msg, 'requested-attributes'))
    const wantAll = requested.length === 0 || requested.includes('all')
    const attrs = printerAttributes(printer, wantAll ? null : new Set(requested))
    return encodeIppMessage({
      code: STATUS_OK,
      requestId: msg.requestId,
      groups: [
        { tag: GROUP_OPERATION, attributes: [attr.charset('attributes-charset', 'utf-8'), attr.naturalLanguage('attributes-natural-language', 'en')] },
        { tag: GROUP_PRINTER, attributes: attrs },
      ],
    })
  }

  // ---------------- Print-Job (0x0002)

  private async handlePrintJob(msg: IppMessage, target: string | null): Promise<Uint8Array> {
    const found = this.requirePrinter(target, msg.requestId)
    if ('response' in found) return found.response
    const printer = found.printer

    const operationGroup = msg.groups.find((g) => g.tag === GROUP_OPERATION)
    const jobGroup = msg.groups.find((g) => isJobGroup(g))
    const userName = attrStr(findIn(operationGroup, 'requesting-user-name')) ?? 'anonymous'
    const jobName = attrStr(findIn(operationGroup, 'job-name')) ?? 'untitled'
    const format = attrStr(findIn(operationGroup, 'document-format')) ?? 'application/octet-stream'
    if (format !== 'application/pdf') {
      return encodeIppMessage({
        code: 0x040b, // client-error-document-format-not-supported
        requestId: msg.requestId,
        groups: [errorOperationGroup(`document-format 不支持：${format}（仅 application/pdf）`)],
      })
    }
    const pdf = msg.data
    if (pdf.length === 0) {
      return encodeIppMessage({
        code: STATUS_CLIENT_ERROR_BAD_REQUEST,
        requestId: msg.requestId,
        groups: [errorOperationGroup('请求缺少文档数据（end-tag 后无 data）')],
      })
    }
    const copies = attrInt(findIn(jobGroup, 'copies')) ?? 1
    const sides = attrStr(findIn(jobGroup, 'sides')) ?? 'one-sided'
    const media = attrStr(findIn(jobGroup, 'media')) ?? 'A4'
    const colorMode = attrStr(findIn(jobGroup, 'print-color-mode')) ?? 'color'
    const quality = attrInt(findIn(jobGroup, 'print-quality')) ?? 4

    const pageCount = (await exactPageCount(pdf)) ?? 1
    const safeCopies = Math.max(1, Math.min(999, copies))
    const jobId = printer.nextJobId++
    const uuid = `vjob-${randomUUID().slice(0, 8)}`
    const record: VippJobRecord = {
      jobId,
      uuid,
      jobName,
      userName,
      format,
      copies: safeCopies,
      sides,
      media,
      colorMode,
      quality,
      sizeBytes: pdf.length,
      impressionsTotal: Math.max(1, pageCount * safeCopies),
      impressionsCompleted: 0,
      sheetsCompleted: 0,
      state: 'pending',
      submittedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    }
    const dir = printer.jobDir(uuid)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, 'document.pdf'), pdf)
    await printer.persistJob(record, true)
    printer.jobs.set(uuid, record)
    printer.queue.push(record)
    printer.recomputeState()
    await printer.persistPrinter()
    this.opts.bus?.emit('vipp:update', { printer: printer.snapshot() })

    return encodeIppMessage({
      code: STATUS_OK,
      requestId: msg.requestId,
      groups: [
        { tag: GROUP_OPERATION, attributes: [attr.charset('attributes-charset', 'utf-8'), attr.naturalLanguage('attributes-natural-language', 'en')] },
        {
          tag: GROUP_JOB_RESPONSE,
          attributes: [
            attr.integer('job-id', jobId),
            attr.uri('job-uri', `${this.printerUri(printer.profile.id)}/${jobId}`),
            attr.enum('job-state', JOB_STATE_TO_IPP.pending),
            attr.keyword('job-state-reasons', JOB_STATE_REASONS.pending),
          ],
        },
      ],
    })
  }

  // ---------------- Get-Job-Attributes (0x0009)

  private handleGetJobAttributes(msg: IppMessage, target: string | null): Uint8Array {
    const found = this.requirePrinter(target, msg.requestId)
    if ('response' in found) return found.response
    const printer = found.printer
    const jobId = extractJobId(msg)
    if (jobId === null) {
      return encodeIppMessage({
        code: STATUS_CLIENT_ERROR_BAD_REQUEST,
        requestId: msg.requestId,
        groups: [errorOperationGroup('缺少 job-id / job-uri')],
      })
    }
    const job = printer.findJob(jobId)
    if (!job) {
      return encodeIppMessage({
        code: STATUS_CLIENT_ERROR_NOT_FOUND,
        requestId: msg.requestId,
        groups: [errorOperationGroup(`任务不存在：${printer.profile.id}#${jobId}`)],
      })
    }
    return encodeIppMessage({
      code: STATUS_OK,
      requestId: msg.requestId,
      groups: [
        { tag: GROUP_OPERATION, attributes: [attr.charset('attributes-charset', 'utf-8'), attr.naturalLanguage('attributes-natural-language', 'en')] },
        { tag: GROUP_JOB_RESPONSE, attributes: jobAttributes(job, this.printerUri(printer.profile.id)) },
      ],
    })
  }

  // ---------------- Get-Jobs (0x000A)

  private handleGetJobs(msg: IppMessage, target: string | null): Uint8Array {
    const found = this.requirePrinter(target, msg.requestId)
    if ('response' in found) return found.response
    const printer = found.printer
    const which = attrStr(findAttr(msg, 'which-jobs')) ?? 'not-completed'
    const jobs = [...printer.jobs.values()].filter((j) => {
      if (which === 'completed') return j.state === 'completed' || j.state === 'canceled' || j.state === 'aborted'
      if (which === 'all') return true
      return j.state !== 'completed' && j.state !== 'canceled' && j.state !== 'aborted'
    })
    jobs.sort((a, b) => a.jobId - b.jobId)
    const groups: EncGroup[] = [
      { tag: GROUP_OPERATION, attributes: [attr.charset('attributes-charset', 'utf-8'), attr.naturalLanguage('attributes-natural-language', 'en')] },
      ...jobs.map((job) => ({ tag: GROUP_JOB_RESPONSE, attributes: jobAttributes(job, this.printerUri(printer.profile.id)) })),
    ]
    return encodeIppMessage({ code: STATUS_OK, requestId: msg.requestId, groups })
  }

  // ---------------- Cancel-Job (0x0008)

  private async handleCancelJob(msg: IppMessage, target: string | null): Promise<Uint8Array> {
    const found = this.requirePrinter(target, msg.requestId)
    if ('response' in found) return found.response
    const printer = found.printer
    const jobId = extractJobId(msg)
    if (jobId === null) {
      return encodeIppMessage({
        code: STATUS_CLIENT_ERROR_BAD_REQUEST,
        requestId: msg.requestId,
        groups: [errorOperationGroup('缺少 job-id / job-uri')],
      })
    }
    const job = printer.findJob(jobId)
    if (!job) {
      return encodeIppMessage({
        code: STATUS_CLIENT_ERROR_NOT_FOUND,
        requestId: msg.requestId,
        groups: [errorOperationGroup(`任务不存在：${printer.profile.id}#${jobId}`)],
      })
    }
    if (job.state === 'completed' || job.state === 'canceled' || job.state === 'aborted') {
      return encodeIppMessage({
        code: STATUS_CLIENT_ERROR_NOT_POSSIBLE,
        requestId: msg.requestId,
        groups: [errorOperationGroup(`任务 ${jobId} 已处于终态（${job.state}），无法取消`)],
      })
    }
    job.state = 'canceled'
    job.finishedAt = new Date().toISOString()
    if (printer.active === job) printer.active = null
    printer.queue = printer.queue.filter((j) => j !== job)
    printer.recomputeState()
    await printer.persistJob(job, true)
    this.opts.bus?.emit('vipp:update', { printer: printer.snapshot() })
    console.log(`[vipp] Cancel-Job：${printer.profile.id}#${jobId} 已取消`)
    return encodeIppMessage({
      code: STATUS_OK,
      requestId: msg.requestId,
      groups: [{ tag: GROUP_OPERATION, attributes: [attr.charset('attributes-charset', 'utf-8'), attr.naturalLanguage('attributes-natural-language', 'en')] }],
    })
  }

  // ---------------- Validate-Job (0x000C)

  private handleValidateJob(msg: IppMessage, target: string | null): Uint8Array {
    const found = this.requirePrinter(target, msg.requestId)
    if ('response' in found) return found.response
    const format = attrStr(findAttr(msg, 'document-format')) ?? 'application/pdf'
    if (format !== 'application/pdf') {
      return encodeIppMessage({
        code: 0x040b,
        requestId: msg.requestId,
        groups: [errorOperationGroup(`document-format 不支持：${format}`)],
      })
    }
    return encodeIppMessage({
      code: STATUS_OK,
      requestId: msg.requestId,
      groups: [{ tag: GROUP_OPERATION, attributes: [attr.charset('attributes-charset', 'utf-8'), attr.naturalLanguage('attributes-natural-language', 'en')] }],
    })
  }

  // ---------------------------------------------------------------- 引擎 tick

  private tick(): void {
    for (const printer of this.printers.values()) {
      try {
        this.tickPrinter(printer)
      } catch (err) {
        console.error(`[vipp] tick(${printer.profile.id}) error:`, err)
      }
    }
  }

  private tickPrinter(printer: VippPrinter): void {
    // 1) 条件阻塞：stopped，不取新任务、不推进
    if (printer.condition !== 'none') {
      printer.state = 'stopped'
      return
    }
    // 2) 取队首开印
    if (!printer.active && printer.queue.length > 0) {
      const job = printer.queue.shift()
      if (!job) return
      job.state = 'processing'
      job.startedAt = job.startedAt ?? new Date().toISOString()
      printer.active = job
      printer.recomputeState()
      void printer.persistJob(job, true)
      this.opts.bus?.emit('vipp:update', { printer: printer.snapshot() })
      return
    }
    // 3) 推进
    const job = printer.active
    if (!job || job.state !== 'processing') return
    const impressionsPerTick = (printer.ppm / 60) * (TICK_MS / 1000)
    const before = job.impressionsCompleted
    job.impressionsCompleted = Math.min(job.impressionsTotal, job.impressionsCompleted + impressionsPerTick)
    const duplexFactor = job.sides === 'one-sided' ? 1 : 2
    job.sheetsCompleted = Math.floor(job.impressionsCompleted / duplexFactor)
    if (job.impressionsCompleted >= job.impressionsTotal) {
      job.impressionsCompleted = job.impressionsTotal
      job.sheetsCompleted = Math.ceil(job.impressionsTotal / duplexFactor)
      job.state = 'completed'
      job.finishedAt = new Date().toISOString()
      printer.active = null
      printer.completedJobs += 1
      printer.recomputeState()
      void printer.persistJob(job, true)
      void printer.persistPrinter()
      this.opts.bus?.emit('vipp:update', { printer: printer.snapshot() })
      return
    }
    // 节流落盘（进度推进中）
    void printer.persistJob(job)
    // 25/50/75 里程碑时广播快照
    const milestoneBefore = Math.floor(((before / job.impressionsTotal) * 100) / 25)
    const milestoneAfter = Math.floor(((job.impressionsCompleted / job.impressionsTotal) * 100) / 25)
    if (milestoneAfter > milestoneBefore) {
      this.opts.bus?.emit('vipp:update', { printer: printer.snapshot() })
    }
  }
}

// ---------------------------------------------------------------- helpers

function findIn(group: IppGroup | undefined, name: string) {
  return group?.attributes.find((a) => a.name === name)
}

function resolvePrinterId(pathname: string): string | null {
  const m = /^\/printers\/([^/]+)\/?$/.exec(pathname)
  if (!m) return null
  return decodeURIComponent(m[1]!)
}

function extractJobId(msg: IppMessage): number | null {
  const jobGroup = msg.groups.find((g) => isJobGroup(g))
  const jobId = attrInt(findIn(jobGroup, 'job-id'))
  if (jobId !== null) return jobId
  const jobUri = attrStr(findIn(jobGroup, 'job-uri'))
  if (jobUri) {
    const m = /\/(\d+)\/?$/.exec(jobUri)
    if (m) return parseInt(m[1]!, 10)
  }
  return null
}

/** 打印机属性（按档案生成；requested 过滤；vipp-minimal 只暴露 state + name） */
function printerAttributes(printer: VippPrinter, requested: Set<string> | null): EncAttr[] {
  const p = printer.profile
  const out: EncAttr[] = []
  const include = (name: string): boolean => requested === null || requested.has(name)
  const push = (a: EncAttr): void => {
    if (include(a.name)) out.push(a)
  }
  // 所有档案（含 vipp-minimal）必须暴露的
  push(attr.enum('printer-state', printerStateOf(printer)))
  push(attr.name('printer-name', p.displayName))
  if (p.id === 'vipp-minimal') return out
  // 常规档案
  push(attr.keyword('printer-state-reasons', CONDITION_REASONS[printer.condition]))
  push(attr.text('printer-state-message', printer.condition === 'none' ? '' : `condition: ${printer.condition}`))
  push(attr.text('printer-info', p.description))
  push(attr.text('printer-location', p.location))
  push(attr.text('printer-make-and-model', p.makeAndModel))
  push(attr.integer('queued-job-count', printer.queuedJobCount))
  push(attr.integer('printer-up-time', printer.upTimeSec()))
  push(attr.dateTime('printer-current-time', new Date()))
  if (p.colorSupported !== undefined) push(attr.boolean('color-supported', p.colorSupported))
  if (p.sidesSupported) push(attr.keyword('sides-supported', p.sidesSupported))
  if (p.mediaSupported) push(attr.keyword('media-supported', p.mediaSupported))
  if (p.copiesRange) push(attr.range('copies-supported', p.copiesRange[0], p.copiesRange[1]))
  if (p.resolutionDpi) push(attr.resolution('printer-resolution-supported', p.resolutionDpi, p.resolutionDpi, 3))
  if (p.markerLevels) push(attr.integer('marker-levels', p.markerLevels))
  if (p.markerTypes) push(attr.keyword('marker-types', p.markerTypes))
  if (p.markerNames) push(attr.name('marker-names', p.markerNames))
  if (p.markerColors) push(attr.keyword('marker-colors', p.markerColors))
  push(attr.mime('document-format-supported', ['application/pdf']))
  push(attr.integer('printer-pages-per-minute', printer.ppm))
  return out
}

function jobAttributes(job: VippJobRecord, printerUri: string): EncAttr[] {
  const out: EncAttr[] = [
    attr.integer('job-id', job.jobId),
    attr.uri('job-uri', `${printerUri}/${job.jobId}`),
    attr.enum('job-state', JOB_STATE_TO_IPP[job.state]),
    attr.keyword('job-state-reasons', JOB_STATE_REASONS[job.state]),
    attr.name('job-name', job.jobName),
    attr.name('job-originating-user-name', job.userName),
    attr.integer('job-k-octets', Math.ceil(job.sizeBytes / 1024)),
    attr.integer('job-impressions', job.impressionsTotal),
    attr.integer('job-impressions-completed', Math.floor(job.impressionsCompleted)),
    attr.integer('job-media-sheets-completed', job.sheetsCompleted),
  ]
  if (job.error) out.push(attr.text('job-state-message', job.error))
  return out
}

function printerStateOf(printer: VippPrinter): number {
  switch (printer.state) {
    case 'processing':
      return 4
    case 'stopped':
      return 5
    default:
      return 3
  }
}

function errorOperationGroup(message: string): EncGroup {
  return {
    tag: GROUP_OPERATION,
    attributes: [attr.charset('attributes-charset', 'utf-8'), attr.naturalLanguage('attributes-natural-language', 'en'), attr.text('status-message', message)],
  }
}

function sendJson(res: ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

async function readBody(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    total += (chunk as Buffer).length
    if (total > 20 * 1024 * 1024) throw new Error('IPP 请求体过大（max 20MB）')
    chunks.push(chunk as Buffer)
  }
  return new Uint8Array(Buffer.concat(chunks))
}

function safeRequestId(body: Uint8Array): number {
  try {
    return decodeIppMessage(body).requestId
  } catch {
    return 0
  }
}
