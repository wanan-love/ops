import { request as httpRequest } from 'node:http'
import type { CapabilityReport, ConsumableInfo, PrinterStatus } from '../core/types'
import { emptyReport, supportedCap } from './merge'

/**
 * HP LEDM / CDM Vendor Adapter —— OPS 第二个 Vendor Adapter（P9）。
 *
 * 官方证据（HPLIP 3.26.4 源码逆向，docs/vendor-evidence/hplip-code/ + MULTI_BRAND_DRIVERS_ANALYSIS.md）：
 *   - hpmud/jd.c:507-510：HPMUD_LEDM_SCAN_CHANNEL / HPMUD_EWS_LEDM_CHANNEL → TCP 8080；
 *   - base/status.py StatusType10（LEDM）：
 *       GET /DevMgmt/ProductStatusDyn.xml   （状态：psdyn: 命名空间，Status/StatusCategory 文本枚举）
 *       GET /DevMgmt/ConsumableConfigDyn.xml（耗材：ccdyn: 命名空间，ConsumableInfo 节点树）
 *       GET /DevMgmt/MediaHandlingDyn.xml   （纸盒：mhdyn: 命名空间，InputTray/InputBin + Accessories autoDuplexor）
 *   - base/status.py StatusTypeCDM + device.py:1705：GET http://{ip}/cdm/supply/v1/suppliesPublic（CDM JSON，HTTP 80）；
 *   - 颜色码 pen_type10_xlate（pK/CMY/M/C/Y/K/G/mK）与 supplyType→kind element_type10_xlate 均为官方映射表。
 *
 * 探测语义（能力三态红线，与 pjl.ts 同口径）：
 *   - HTTP 连接失败/超时/非 200/解析失败 → ok=false 仅记 probe（不猜测、不影响其它来源）；
 *   - XML/JSON 字段缺失 → 该项跳过或保持 unknown（HPLIP 同款宽容：AttributeError → skip）；
 *   - 状态类别无法映射 → status=null（probe detail 保留原始 StatusCategory）。
 *
 * 与 PJL 的关系：二者同为 VENDOR_API 来源（merge 优先级低于 SNMP/IPP），HP 适配器在
 * PJL 之后探测（通道优先级 IPP → SNMP → PJL → HP LEDM/CDM；状态融合由 routes.ts 守卫链保证）。
 * LEDM 与 CDM 为并列通道（真实 HP 机型按代际二选一居多，全探测取有应答者——仍是实测，非机型猜测）。
 */

// ---------------------------------------------------------------- 常量（HPLIP 官方源码同源）

/** LEDM 文档路径（HPLIP status.py:1756/1894/1970 原样） */
export const LEDM_PATH_STATUS = '/DevMgmt/ProductStatusDyn.xml'
export const LEDM_PATH_CONSUMABLE = '/DevMgmt/ConsumableConfigDyn.xml'
export const LEDM_PATH_MEDIA = '/DevMgmt/MediaHandlingDyn.xml'
/** CDM 端点（HPLIP device.py:1705 原样） */
export const CDM_PATH_SUPPLIES = '/cdm/supply/v1/suppliesPublic'

/** LEDM 默认端口 8080（HPLIP hpmud/jd.c:507-510：HPMUD_EWS_LEDM_CHANNEL）；CDM 默认 80 */
export const LEDM_DEFAULT_PORT = 8080
export const CDM_DEFAULT_PORT = 80

/** LEDM XML 命名空间前缀（HPLIP status.py 解析前逐个 replace 剥除，官方做法照搬） */
const LEDM_NS_PREFIXES = ['psdyn:', 'ccdyn:', 'mhdyn:', 'dd:', 'locid:', 'pscat:', 'ad:']

/** LEDM StatusCategory → OPS PrinterStatus（HPLIP StatusType10 官方枚举中可保守对齐 OPS 六态的子集；
 *  未收录项（fax 系 / scan 系 / wasteMarker 系等）返回 null 不猜测） */
const LEDM_CATEGORY_TO_STATUS: Record<string, PrinterStatus> = {
  ready: 'online',
  processing: 'busy',
  shuttingDown: 'offline',
  inPowerSave: 'offline',
  jamInPrinter: 'paper-jam',
  trayEmptyOrOpen: 'paper-out',
  closeDoorOrCover: 'error',
  hardError: 'error',
}

/** LEDM ConsumableTypeEnum → ConsumableInfo.kind（HPLIP element_type10_xlate 同源语义；
 *  printhead/imageDrum 在 HPLIP 中跳过——此处同样跳过） */
function ledmSupplyKindOf(type: string): ConsumableInfo['kind'] | null {
  switch (type) {
    case 'ink':
    case 'inkTank':
      return 'ink'
    case 'inkCartridge':
      return 'ink'
    case 'toner':
    case 'tonerCartridge':
    case 'rechargeableToner':
      return 'toner'
    case 'printhead':
    case 'imageDrum':
      return null // HPLIP 显式 continue（非耗材余量语义）
    default:
      return 'other'
  }
}

/** LEDM ConsumableLabelCode / CDM supplyColorCode → 颜色显示名（HPLIP pen_type10_xlate 官方表） */
const HP_COLOR_CODE_LABEL: Record<string, string> = {
  K: '黑色',
  pK: '照片黑',
  mK: '哑光黑',
  C: '青色',
  M: '品红',
  Y: '黄色',
  CMY: '三色复合',
  G: '灰',
}

// ---------------------------------------------------------------- HTTP 客户端（LEDM :8080 / CDM :80 通用）

export interface HttpDocOptions {
  host: string
  port: number
  path: string
  timeoutMs?: number
}

/** 单次 HTTP GET 取文档体（超时/非 200/网络错误返回 error；响应体上限 256KB 防御） */
function fetchDocument(opts: HttpDocOptions): Promise<{ body: string; durationMs: number } | { error: string; durationMs: number }> {
  const startedAt = Date.now()
  const timeoutMs = opts.timeoutMs ?? 1200
  return new Promise((resolve) => {
    let settled = false
    const finish = (r: { body: string } | { error: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...r, durationMs: Date.now() - startedAt } as { body: string; durationMs: number } | { error: string; durationMs: number })
    }
    const timer = setTimeout(() => finish({ error: `HTTP 超时（${timeoutMs}ms）` }), timeoutMs)
    const req = httpRequest(
      { host: opts.host, port: opts.port, path: opts.path, method: 'GET', timeout: timeoutMs, headers: { accept: 'text/plain, text/xml, application/json' } },
      (res) => {
        const status = res.statusCode ?? 0
        if (status !== 200) {
          res.resume()
          return finish({ error: `HTTP ${status}` })
        }
        const chunks: Buffer[] = []
        let total = 0
        res.on('data', (chunk: Buffer) => {
          total += chunk.length
          if (total > 256 * 1024) {
            req.destroy()
            return finish({ error: '响应体超限（>256KB）' })
          }
          chunks.push(chunk)
        })
        res.on('end', () => finish({ body: Buffer.concat(chunks).toString('utf-8') }))
        res.on('error', (err) => finish({ error: err.code ?? err.message }))
      },
    )
    req.on('error', (err) => finish({ error: err.code ?? err.message }))
    req.on('timeout', () => {
      req.destroy()
      finish({ error: `HTTP 超时（${timeoutMs}ms）` })
    })
    req.end()
  })
}

// ---------------------------------------------------------------- LEDM XML 解析（纯函数，可单测）

/** 剥除 LEDM 命名空间前缀（HPLIP 同做法：psdyn:/ccdyn:… 逐个 replace） */
function stripNamespaces(xml: string): string {
  let out = xml
  for (const ns of LEDM_NS_PREFIXES) out = out.split(ns).join('')
  return out
}

/** 提取首个 XML 元素体的内侧文本（<ConsumableTypeEnum>ink</…> → ink）。无标签或自闭合返回 null */
function xmlText(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, 'i').exec(xml)
  return m ? (m[1] ?? '').trim() : null
}

/** 提取指定路径下所有元素片段（e.g. ConsumableInfo 重复节点）。返回标签体原文列表（宽容：不校验嵌套深度） */
function xmlElements(xml: string, tag: string): string[] {
  const out: string[] = []
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi')
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) out.push(m[1] ?? '')
  return out
}

/** LEDM ProductStatusDyn.xml → 状态。成功解析含 StatusCategory 才返回 category（未知类别 → category 保留原文、status null） */
export function parseLedmStatusXml(xml: string): { status: PrinterStatus | null; category: string | null } {
  const clean = stripNamespaces(xml)
  // HPLIP findall("Status/StatusCategory")：取 Status 节点下的 StatusCategory（宽容：无 Status 包裹时直接找 StatusCategory）
  const inStatus = xmlElements(clean, 'Status')[0] ?? clean
  const categories = xmlElements(inStatus, 'StatusCategory')
  if (categories.length === 0) return { status: null, category: null }
  // HPLIP 逐个 if/elif，最后一个命中的覆盖前面（多状态并存时后者胜）——此处保持同语义
  let matched: PrinterStatus | null = null
  let lastCategory = ''
  for (const raw of categories) {
    const text = raw.trim()
    if (text === '') continue
    lastCategory = text
    const mapped = LEDM_CATEGORY_TO_STATUS[text]
    if (mapped) matched = mapped
  }
  return { status: matched, category: lastCategory || null }
}

/** LEDM ConsumableConfigDyn.xml → 耗材列表（HPLIP StatusType10Agents 同构：宽容逐节点，字段缺失跳过） */
export function parseLedmConsumableXml(xml: string): ConsumableInfo[] {
  const clean = stripNamespaces(xml)
  const out: ConsumableInfo[] = []
  for (const node of xmlElements(clean, 'ConsumableInfo')) {
    const type = xmlText(node, 'ConsumableTypeEnum')
    if (!type) continue // HPLIP AttributeError → skip
    const kind = ledmSupplyKindOf(type)
    if (kind === null) continue // printhead/imageDrum：HPLIP 显式跳过
    const state = xmlText(node, 'ConsumableLifeState/ConsumableState') ?? xmlText(node, 'ConsumableState')
    const labelCode = xmlText(node, 'ConsumableLabelCode')
    const pctRaw = xmlText(node, 'ConsumablePercentageLevelRemaining')
    const sku = xmlText(node, 'ProductNumber') ?? xmlText(node, 'ConsumableSelectibilityNumber')
    // level 解析：非数字或缺失 → null（不猜测；HPLIP except → ink_level=0 属其内部约定，OPS 红线取 null）
    const pct = pctRaw !== null && /^\d+$/.test(pctRaw) ? Number(pctRaw) : null
    const level = pct !== null && pct >= 0 && pct <= 100 ? pct : null
    // missing 状态：HPLIP 不读 level；OPS 同口径（missing → 余量无意义，显示 null）
    const levelPct = state === 'missing' ? null : level
    const colorLabel = labelCode ? (HP_COLOR_CODE_LABEL[labelCode] ?? labelCode) : undefined
    const nameParts = [colorLabel ?? '', kind === 'toner' ? '碳粉' : kind === 'ink' ? '墨水' : '耗材']
    const name = sku ? `${sku}（${nameParts.filter(Boolean).join(' ')}）` : `${HP_BRAND} ${nameParts.filter(Boolean).join(' ')}`
    out.push({ name, kind, color: colorLabel, levelPct, source: 'VENDOR_API' })
  }
  return out
}

/** LEDM MediaHandlingDyn.xml → 纸盒 + 双面器（HPLIP StatusType10Media 同构：InputTray/InputBin 枚举 + autoDuplexor） */
export function parseLedmMediaXml(xml: string): { trays: string[]; hasAutoDuplexor: boolean | null } {
  const clean = stripNamespaces(xml)
  const trays: string[] = []
  for (const node of xmlElements(clean, 'InputTray')) {
    const bin = xmlText(node, 'InputBin')
    if (bin && !trays.includes(bin)) trays.push(bin)
  }
  const hasTrays = trays.length > 0
  const duplexNode = xmlElements(clean, 'MediaHandlingDeviceFunctionType').some((t) => t.trim() === 'autoDuplexor')
  // 双面器三态：读到 Accessories 节点 → true/false（有/无 autoDuplexor 都算实读）；整文档缺失 → null 不猜测
  const accessoriesPresent = /<Accessories[\s>]/i.test(clean)
  return { trays: hasTrays ? trays : [], hasAutoDuplexor: accessoriesPresent ? duplexNode : null }
}

// ---------------------------------------------------------------- CDM JSON 解析（纯函数，可单测）

interface CdmSupplyEntry {
  supplyType?: string
  supplyState?: string
  supplyColorCode?: string
  percentLifeDisplay?: number | string
  productNumber?: string
  selectabilityNumber?: string | number
}

/** CDM /cdm/supply/v1/suppliesPublic → 耗材列表（HPLIP StatusTypeCDMAgents_Net 同构：suppliesList 逐项宽容解析） */
export function parseCdmSuppliesJson(text: string): ConsumableInfo[] {
  let data: { suppliesList?: CdmSupplyEntry[] }
  try {
    data = JSON.parse(text) as { suppliesList?: CdmSupplyEntry[] }
  } catch {
    return []
  }
  const list = Array.isArray(data.suppliesList) ? data.suppliesList : []
  const out: ConsumableInfo[] = []
  for (const each of list) {
    const type = each.supplyType
    if (!type) continue
    const kind = ledmSupplyKindOf(type)
    if (kind === null) continue // printhead/imageDrum：HPLIP 显式跳过
    const state = each.supplyState
    const colorCode = each.supplyColorCode
    const pctRaw = each.percentLifeDisplay
    const pct = pctRaw !== undefined && /^\d+(\.\d+)?$/.test(String(pctRaw)) ? Math.round(Number(pctRaw)) : null
    const level = pct !== null && pct >= 0 && pct <= 100 ? pct : null
    const levelPct = state === 'missing' ? null : level
    const sku = each.productNumber ?? (each.selectabilityNumber !== undefined ? String(each.selectabilityNumber) : undefined)
    const colorLabel = colorCode ? (HP_COLOR_CODE_LABEL[colorCode] ?? colorCode) : undefined
    const nameParts = [colorLabel ?? '', kind === 'toner' ? '碳粉' : kind === 'ink' ? '墨水' : '耗材']
    const name = sku ? `${sku}（${nameParts.filter(Boolean).join(' ')}）` : `${HP_BRAND} ${nameParts.filter(Boolean).join(' ')}`
    out.push({ name, kind, color: colorLabel, levelPct, source: 'VENDOR_API' })
  }
  return out
}

const HP_BRAND = 'HP'

// ---------------------------------------------------------------- 对外探测 API

export interface HpProbeOptions {
  host: string
  /** LEDM HTTP 端口（真实 HP 8080；测试指向 Virtual LEDM :3068） */
  ledmPort: number
  /** CDM HTTP 端口（真实 HP 80；测试指向 Virtual LEDM :3068 同一服务的 JSON 端点） */
  cdmPort: number
  timeoutMs?: number
}

export interface HpProbeResult {
  /** 任一通道应答即 true（LEDM 或 CDM） */
  ok: boolean
  durationMs: number
  /** 映射后的状态（null = 未知/无法映射/全部通道失败） */
  status: PrinterStatus | null
  /** 原始 StatusCategory（诊断用） */
  rawCategory: string | null
  /** 耗材（LEDM ConsumableConfigDyn 与 CDM suppliesPublic 均成功时 LEDM 优先——LEDM 字段更丰富） */
  consumables: ConsumableInfo[]
  /** 纸盒（LEDM MediaHandlingDyn） */
  trays: string[] | null
  /** 双面器（LEDM Accessories；null = 未读取到该文档） */
  hasAutoDuplexor: boolean | null
  /** 合入 VENDOR_API 的 CapabilityReport（探测失败时全 unknown + probe） */
  report: CapabilityReport
  /** 逐通道明细（诊断） */
  channels: Array<{ channel: 'LEDM_STATUS' | 'LEDM_CONSUMABLE' | 'LEDM_MEDIA' | 'CDM'; ok: boolean; durationMs: number; error?: string }>
}

/** HP LEDM/CDM 探测（四文档并行；任何失败仅记 probe 不猜测） */
export async function probeHpLedmCdm(opts: HpProbeOptions): Promise<HpProbeResult> {
  const startedAt = Date.now()
  const timeoutMs = opts.timeoutMs ?? 1200
  const base = { host: opts.host, timeoutMs }
  const [statusDoc, consumableDoc, mediaDoc, cdmDoc] = await Promise.all([
    fetchDocument({ ...base, port: opts.ledmPort, path: LEDM_PATH_STATUS }),
    fetchDocument({ ...base, port: opts.ledmPort, path: LEDM_PATH_CONSUMABLE }),
    fetchDocument({ ...base, port: opts.ledmPort, path: LEDM_PATH_MEDIA }),
    fetchDocument({ ...base, port: opts.cdmPort, path: CDM_PATH_SUPPLIES }),
  ])

  const channels: HpProbeResult['channels'] = []
  const pushChannel = (c: HpProbeResult['channels'][number]['channel'], r: { body: string } | { error: string }) => {
    if ('error' in r) channels.push({ channel: c, ok: false, durationMs: r.durationMs, error: r.error })
    else channels.push({ channel: c, ok: true, durationMs: r.durationMs })
  }
  pushChannel('LEDM_STATUS', statusDoc)
  pushChannel('LEDM_CONSUMABLE', consumableDoc)
  pushChannel('LEDM_MEDIA', mediaDoc)
  pushChannel('CDM', cdmDoc)

  // 状态：仅 LEDM ProductStatusDyn
  let status: PrinterStatus | null = null
  let rawCategory: string | null = null
  if ('body' in statusDoc) {
    const parsed = parseLedmStatusXml(statusDoc.body)
    status = parsed.status
    rawCategory = parsed.category
  }

  // 耗材：LEDM 优先（字段丰富），失败用 CDM
  let consumables: ConsumableInfo[] = []
  let consumablesDetail = ''
  if ('body' in consumableDoc) {
    consumables = parseLedmConsumableXml(consumableDoc.body)
    if (consumables.length > 0) consumablesDetail = `LEDM ConsumableConfigDyn（${consumables.length} 项）`
  }
  if (consumables.length === 0 && 'body' in cdmDoc) {
    consumables = parseCdmSuppliesJson(cdmDoc.body)
    if (consumables.length > 0) consumablesDetail = `CDM suppliesPublic（${consumables.length} 项）`
  }

  // 纸盒/双面器：仅 LEDM MediaHandlingDyn
  let trays: string[] | null = null
  let hasAutoDuplexor: boolean | null = null
  if ('body' in mediaDoc) {
    const media = parseLedmMediaXml(mediaDoc.body)
    trays = media.trays.length > 0 ? media.trays : null
    hasAutoDuplexor = media.hasAutoDuplexor
  }

  const anyOk = channels.some((c) => c.ok)
  const report = emptyReport('VENDOR_API')
  if (consumables.length > 0) {
    report.consumables = supportedCap(consumables, 'VENDOR_API', consumablesDetail)
  }
  if (trays !== null && hasAutoDuplexor !== null) {
    // 纸盒与双面器同源同文档，一并声明（duplex 只到「有/无自动双面器」粒度，不区分长短边——LEDM 文档本身无此信息）
    report.paperTrays = supportedCap(trays, 'VENDOR_API', 'LEDM MediaHandlingDyn InputTray/InputBin')
    report.duplex = supportedCap(hasAutoDuplexor ? 'both' : 'none', 'VENDOR_API', hasAutoDuplexor ? 'LEDM Accessories autoDuplexor（有，翻转模式未知→both 宽松）' : 'LEDM Accessories 无 autoDuplexor')
  }
  const firstOk = channels.find((c) => c.ok)
  report.probes.push({
    source: 'VENDOR_API',
    ok: anyOk,
    durationMs: Date.now() - startedAt,
    error: anyOk ? undefined : channels.map((c) => `${c.channel}:${c.error}`).join(' | '),
    detail: anyOk
      ? `HP LEDM/CDM${firstOk ? `（${firstOk.channel} 应答` : ''}${rawCategory ? `，StatusCategory=${rawCategory}` : ''}）`
      : undefined,
    at: new Date().toISOString(),
  })

  return {
    ok: anyOk,
    durationMs: Date.now() - startedAt,
    status,
    rawCategory,
    consumables,
    trays,
    hasAutoDuplexor,
    report,
    channels,
  }
}

/** 从任意后端 URI 提取主机名（ipp://host:port/... → host；与 pjlHostFromUri 同口径） */
export function hpHostFromUri(uri: string): string | null {
  try {
    return new URL(uri).hostname
  } catch {
    return null
  }
}
