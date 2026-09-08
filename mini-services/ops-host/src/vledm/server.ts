import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

/**
 * Virtual HP LEDM/CDM Printer — HTTP 8080 仿真服务（端口 3068，仅开发/测试模式）。
 *
 * 目的：在无实体 HP 打印机的沙箱中，验证「P9 Vendor Adapter：HP LEDM/CDM 探测」全链路：
 *   hp-ledm client（node http GET）→ 本服务（XML/JSON 应答，命名空间对齐 HPLIP 源码 schema）→ mergeReports。
 *
 * 应答文档（路径与命名空间均对齐 HPLIP 3.26.4 源码，docs/vendor-evidence/hplip-code/status.py）：
 *   - GET /DevMgmt/ProductStatusDyn.xml  （psdyn:/dd: 命名空间；Status/StatusCategory 枚举）
 *   - GET /DevMgmt/ConsumableConfigDyn.xml（ccdyn:/dd: 命名空间；ConsumableInfo 节点树）
 *   - GET /DevMgmt/MediaHandlingDyn.xml   （mhdyn:/dd: 命名空间；InputTray/InputBin + Accessories）
 *   - GET /cdm/supply/v1/suppliesPublic   （CDM JSON：suppliesList）
 *
 * 调试注入（POST /api/vledm/condition）：ready（默认：StatusCategory=ready，四色墨 62/45/50/58%）/
 *   busy / paper-out / paper-jam / door-open / hard-error / toner-low（黑墨 8%）/ toner-empty（黑墨 0%+empty）
 *
 * 宽容解析路径验证：POST /api/vledm/style 注入 namespaced（默认，带前缀）/ bare（无前缀）/ 404（文档 404）——
 *   验证客户端命名空间剥除与探测失败→UNKNOWN 语义。
 */

export type VledmCondition =
  | 'ready'
  | 'busy'
  | 'paper-out'
  | 'paper-jam'
  | 'door-open'
  | 'hard-error'
  | 'toner-low'
  | 'toner-empty'

export const VLEDM_CONDITIONS: VledmCondition[] = ['ready', 'busy', 'paper-out', 'paper-jam', 'door-open', 'hard-error', 'toner-low', 'toner-empty']

/** condition → LEDM StatusCategory（HPLIP StatusType10 官方枚举值原样） */
const CONDITION_CATEGORY: Record<VledmCondition, string> = {
  ready: 'ready',
  busy: 'processing',
  'paper-out': 'trayEmptyOrOpen',
  'paper-jam': 'jamInPrinter',
  'door-open': 'closeDoorOrCover',
  'hard-error': 'hardError',
  'toner-low': 'ready',
  'toner-empty': 'ready',
}

/** 墨水余量（toner 系条件覆盖黑色；CMY 固定演示值） */
const INK_LEVELS: Record<string, number> = { K: 62, C: 45, M: 50, Y: 58 }
const CONDITION_BLACK: Partial<Record<VledmCondition, number>> = { 'toner-low': 8, 'toner-empty': 0 }

export type VledmStyle = 'namespaced' | 'bare' | '404'

export interface VledmState {
  condition: VledmCondition
  /** XML 命名空间风格（namespaced=真实 HP 同款前缀 / bare=无前缀 / 404=全部文档 404） */
  style: VledmStyle
  /** 服务累计收到的 HTTP 请求数（含 404） */
  requestCount: number
  updatedAt: string
}

export interface VledmServerOptions {
  port: number
  dataDir?: string
}

export class VirtualLedmServer {
  private server: Server | null = null
  private condition: VledmCondition = 'ready'
  private style: VledmStyle = 'namespaced'
  private requestCount = 0
  readonly port: number
  readonly dataDir: string

  constructor(private readonly opts: VledmServerOptions) {
    this.port = opts.port
    this.dataDir = opts.dataDir ?? ''
  }

  async start(): Promise<void> {
    if (this.dataDir) {
      await fs.mkdir(this.dataDir, { recursive: true }).catch(() => {})
      await this.loadState().catch(() => {})
    }
    await new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => this.handleRequest(req, res))
      server.on('error', reject)
      server.listen(this.port, () => resolve())
      this.server = server
    })
    console.log(`[vledm] Virtual HP LEDM/CDM Printer listening on :${this.port} (condition=${this.condition}, style=${this.style})`)
  }

  stop(): void {
    this.server?.close()
    this.server = null
  }

  state(): VledmState {
    return { condition: this.condition, style: this.style, requestCount: this.requestCount, updatedAt: new Date().toISOString() }
  }

  setCondition(condition: string): VledmState | null {
    if (!VLEDM_CONDITIONS.includes(condition as VledmCondition)) return null
    this.condition = condition as VledmCondition
    const next = this.state()
    void this.persistState().catch(() => {})
    console.log(`[vledm] condition → ${condition}（StatusCategory=${CONDITION_CATEGORY[this.condition]}）`)
    return next
  }

  setStyle(style: string): VledmState | null {
    if (style !== 'namespaced' && style !== 'bare' && style !== '404') return null
    this.style = style as VledmStyle
    const next = this.state()
    void this.persistState().catch(() => {})
    console.log(`[vledm] style → ${style}`)
    return next
  }

  // ---------------------------------------------------------------- HTTP 处理

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    this.requestCount += 1
    const url = (req.url ?? '').split('?')[0] ?? ''
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain' })
      return void res.end('Method Not Allowed')
    }
    if (this.style === '404') {
      res.writeHead(404, { 'content-type': 'text/plain' })
      return void res.end('Not Found')
    }
    const ns = this.style === 'namespaced'
    switch (url) {
      case '/DevMgmt/ProductStatusDyn.xml':
        return this.sendXml(res, this.docProductStatus(ns))
      case '/DevMgmt/ConsumableConfigDyn.xml':
        return this.sendXml(res, this.docConsumableConfig(ns))
      case '/DevMgmt/MediaHandlingDyn.xml':
        return this.sendXml(res, this.docMediaHandling(ns))
      case '/cdm/supply/v1/suppliesPublic':
        return this.sendJson(res, this.docCdmSupplies())
      default:
        res.writeHead(404, { 'content-type': 'text/plain' })
        return void res.end('Not Found')
    }
  }

  private sendXml(res: ServerResponse, body: string): void {
    res.writeHead(200, { 'content-type': 'text/xml; charset=utf-8', 'content-length': Buffer.byteLength(body) })
    res.end(body)
  }

  private sendJson(res: ServerResponse, body: string): void {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
    res.end(body)
  }

  // ---------------------------------------------------------------- 文档生成（对齐 HPLIP 解析路径的 schema）

  private blackLevel(): number {
    return CONDITION_BLACK[this.condition] ?? INK_LEVELS.K!
  }

  /** ProductStatusDyn：Status/StatusCategory（HPLIP findall("Status/StatusCategory")） */
  private docProductStatus(ns: boolean): string {
    const p = (tag: string): string => (ns ? `psdyn:${tag}` : tag)
    return `<?xml version="1.0" encoding="UTF-8"?>
<${ns ? 'psdyn:' : ''}ProductStatusDyn xmlns:psdyn="http://www.hp.com/schemas/2009/05/psdyn" xmlns:dd="http://www.hp.com/schemas/2009/05/dd/dd3" xmlns:locid="http://www.hp.com/schemas/2009/05/locid">
 <${p('Status')}>
  <${p('StatusCategory')}>${CONDITION_CATEGORY[this.condition]}</${p('StatusCategory')}>
 </${p('Status')}>
</${ns ? 'psdyn:' : ''}ProductStatusDyn>`
  }

  /** ConsumableConfigDyn：ConsumableInfo 节点树（HPLIP findall("ConsumableInfo") 逐节点字段） */
  private docConsumableConfig(ns: boolean): string {
    const p = (tag: string): string => (ns ? `ccdyn:${tag}` : tag)
    const black = this.blackLevel()
    const empty = this.condition === 'toner-empty'
    const mk = (code: string, pct: number, sku: string, isEmpty = false): string => `  <${ns ? 'ccdyn:' : ''}ConsumableInfo>
   <${p('MarkerColor')}>#${code === 'K' ? '000000' : code === 'C' ? '00FFFF' : code === 'M' ? 'FF00FF' : 'FFFF00'}</${p('MarkerColor')}>
   <${p('ConsumableTypeEnum')}>ink</${p('ConsumableTypeEnum')}>
   <${p('ConsumableLabelCode')}>${code}</${p('ConsumableLabelCode')}>
   <${p('ProductNumber')}>${sku}</${p('ProductNumber')}>
   <${p('ConsumableLifeState')}>
    <${p('ConsumableState')}>${isEmpty ? 'empty' : 'ok'}</${p('ConsumableState')}>
    <${p('MeasuredQuantityState')}>${isEmpty ? 'empty' : 'ok'}</${p('MeasuredQuantityState')}>
   </${p('ConsumableLifeState')}>
   <${p('ConsumablePercentageLevelRemaining')}>${pct}</${p('ConsumablePercentageLevelRemaining')}>
  </${ns ? 'ccdyn:' : ''}ConsumableInfo>`
    const items = [mk('K', black, 'C2P04AE', empty), mk('C', INK_LEVELS.C!, 'C2P05AE'), mk('M', INK_LEVELS.M!, 'C2P06AE'), mk('Y', INK_LEVELS.Y!, 'C2P07AE')]
    return `<?xml version="1.0" encoding="UTF-8"?>
<${ns ? 'ccdyn:' : ''}ConsumableConfigDyn xmlns:ccdyn="http://www.hp.com/schemas/2009/05/ccdyn" xmlns:dd="http://www.hp.com/schemas/2009/05/dd/dd3">
${items.join('\n')}
</${ns ? 'ccdyn:' : ''}ConsumableConfigDyn>`
  }

  /** MediaHandlingDyn：InputTray/InputBin + Accessories autoDuplexor（HPLIP StatusType10Media 路径） */
  private docMediaHandling(ns: boolean): string {
    const p = (tag: string): string => (ns ? `mhdyn:${tag}` : tag)
    return `<?xml version="1.0" encoding="UTF-8"?>
<${ns ? 'mhdyn:' : ''}MediaHandlingDyn xmlns:mhdyn="http://www.hp.com/schemas/2009/05/mhdyn" xmlns:dd="http://www.hp.com/schemas/2009/05/dd/dd3">
 <${ns ? 'mhdyn:' : ''}InputTrays>
  <${ns ? 'mhdyn:' : ''}InputTray>
   <${p('InputBin')}>Tray1</${p('InputBin')}>
   <${p('FeedOrientation')}>ShortEdgeFirst</${p('FeedOrientation')}>
  </${ns ? 'mhdyn:' : ''}InputTray>
  <${ns ? 'mhdyn:' : ''}InputTray>
   <${p('InputBin')}>Tray2</${p('InputBin')}>
   <${p('FeedOrientation')}>ShortEdgeFirst</${p('FeedOrientation')}>
  </${ns ? 'mhdyn:' : ''}InputTray>
  <${ns ? 'mhdyn:' : ''}InputTray>
   <${p('InputBin')}>PhotoTray</${p('InputBin')}>
   <${p('FeedOrientation')}>ShortEdgeFirst</${p('FeedOrientation')}>
  </${ns ? 'mhdyn:' : ''}InputTray>
 </${ns ? 'mhdyn:' : ''}InputTrays>
 <${ns ? 'mhdyn:' : ''}Accessories>
  <${p('MediaHandlingDeviceFunctionType')}>autoDuplexor</${p('MediaHandlingDeviceFunctionType')}>
 </${ns ? 'mhdyn:' : ''}Accessories>
</${ns ? 'mhdyn:' : ''}MediaHandlingDyn>`
  }

  /** CDM suppliesPublic JSON（HPLIP StatusTypeCDMAgents_Net：suppliesList 逐项字段） */
  private docCdmSupplies(): string {
    const black = this.blackLevel()
    const empty = this.condition === 'toner-empty'
    const mk = (colorCode: string, pct: number, sku: string, isEmpty = false): object => ({
      supplyType: 'ink',
      supplyState: isEmpty ? 'empty' : 'ok',
      supplyColorCode: colorCode,
      percentLifeDisplay: pct,
      productNumber: sku,
      brand: 'HP',
    })
    return JSON.stringify({ suppliesList: [mk('K', black, 'C2P04AE', empty), mk('C', INK_LEVELS.C!, 'C2P05AE'), mk('M', INK_LEVELS.M!, 'C2P06AE'), mk('Y', INK_LEVELS.Y!, 'C2P07AE')] })
  }

  // ---------------------------------------------------------------- 持久化

  private stateFile(): string {
    return join(this.dataDir, 'state.json')
  }

  private async loadState(): Promise<void> {
    const raw = await fs.readFile(this.stateFile(), 'utf-8')
    const data = JSON.parse(raw) as Partial<VledmState>
    if (data.condition && VLEDM_CONDITIONS.includes(data.condition as VledmCondition)) {
      this.condition = data.condition as VledmCondition
    }
    if (data.style === 'namespaced' || data.style === 'bare' || data.style === '404') {
      this.style = data.style
    }
  }

  private async persistState(): Promise<void> {
    if (!this.dataDir) return
    await fs.writeFile(this.stateFile(), JSON.stringify(this.state(), null, 2), 'utf-8').catch(() => {})
  }
}
