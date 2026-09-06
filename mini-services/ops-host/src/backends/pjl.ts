import { connect, type Socket } from 'node:net'
import type { CapabilityReport, ConsumableInfo, PrinterStatus } from '../core/types'
import { emptyReport, supportedCap } from './merge'

/**
 * PJL over RAW 9100 双向探测客户端 —— OPS 首个 Vendor Adapter 试点（P4）。
 *
 * 背景（docs/VENDOR_PROTOCOLS.md）：Brother 等品牌的消费/SOHO 机型 SNMP 常缺失/禁用，
 * 但 RAW 9100（HP JetDirect 1992 发明、事实上的打印通用端口）是双向字节流，
 * 可用 @PJL INFO 类命令回读状态/耗材。@PJL INFO STATUS 为 HP PJL 参考手册标准；
 * @PJL INFO SUPPLY 为 Brother 风格试点格式（公开资料未完全标准化，真实机型需抓包适配）。
 *
 * 探测语义（能力三态红线）：
 *   - 连接失败/超时/无响应 → ok=false 仅记 probe（不猜测、不影响其它来源）
 *   - CODE 无法映射 → status=null（detail 保留原始 CODE）
 *   - SUPPLY 无法解析 → consumables 保持 unknown
 *
 * 通道优先级（VENDOR_PROTOCOLS.md）：IPP → SNMP → HOST-RESOURCES-MIB → 厂商 PJL。
 * merge.ts 的 DEFAULT_SOURCE_PRIORITY 已将 VENDOR_API 置于 SNMP 之后，天然满足。
 */

/** UEL（Universal Exit Language） */
const UEL = '\x1b%-12345X'

export interface PjlProbeOptions {
  host: string
  /** RAW 端口（真实设备 9100 通用；测试指向 Virtual PJL :3067） */
  port: number
  timeoutMs?: number
}

export interface PjlStatusResult {
  ok: boolean
  durationMs: number
  /** 映射后的打印机状态（null = 未知/无法映射/探测失败） */
  status: PrinterStatus | null
  /** 状态附言（如 PJL DISPLAY 原文） */
  message: string | null
  /** 原始 CODE（诊断用；映射失败时也保留） */
  rawCode: string | null
  /** DISPLAY 原文 */
  display: string | null
  error?: string
}

export interface PjlSupplyResult {
  ok: boolean
  durationMs: number
  /** CapabilityReport（consumables 支持时填 VENDOR_API 来源） */
  report: CapabilityReport
  error?: string
}

// ---------------------------------------------------------------- PJL 状态码映射（子集，未知返回 null 不猜测）

/** PJL CODE → OPS PrinterStatus。仅收录公开资料明确且语义可直接对齐的码；其它一律 unknown。 */
const CODE_TO_STATUS: Record<string, { status: PrinterStatus; message: string }> = {
  '10001': { status: 'online', message: 'READY' },
  '10002': { status: 'offline', message: 'OFFLINE' },
  '10003': { status: 'online', message: 'WARMING UP' },
  '10004': { status: 'busy', message: 'PRINTING' },
  '40014': { status: 'paper-out', message: 'PAPER OUT（PJL 40014）' },
  '40017': { status: 'error', message: 'DOOR OPEN（PJL 40017）' },
  '40019': { status: 'paper-jam', message: 'PAPER JAM（PJL 40019）' },
  // 40036 碳粉低 / 40037 碳粉尽：属于耗材域而非状态域——不映射状态（耗材由 INFO SUPPLY 探测）
  // 40037 会阻断打印，但保守起见不猜状态（部分机型仍接收作业排队）
}

/** PJL 耗材 kind 映射（SUPPLY TYPE 字段） */
function supplyKindOf(type: string): ConsumableInfo['kind'] {
  const t = type.toUpperCase()
  if (t.includes('TONER')) return 'toner'
  if (t.includes('INK')) return 'ink'
  if (t.includes('DRUM')) return 'drum'
  if (t.includes('MAINT')) return 'maintenance-kit'
  return 'other'
}

// ---------------------------------------------------------------- 通用 PJL 查询（一次连接一问一答）

/** 建立 TCP 连接并发送一条 UEL 包裹的 @PJL 查询，收集响应字节（超时/错误返回 null） */
async function pjlQuery(opts: PjlProbeOptions, command: string): Promise<{ text: string; durationMs: number } | { error: string; durationMs: number }> {
  const startedAt = Date.now()
  const timeoutMs = opts.timeoutMs ?? 900
  return new Promise((resolve) => {
    let settled = false
    let received = ''
    const finish = (result: { text: string; durationMs: number } | { error: string; durationMs: number }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve({ ...result, durationMs: Date.now() - startedAt } as { text: string; durationMs: number } | { error: string; durationMs: number })
    }
    const socket: Socket = connect({ host: opts.host, port: opts.port })
    const timer = setTimeout(() => finish({ error: `连接超时（${timeoutMs}ms）`, durationMs: 0 }), timeoutMs)
    socket.on('error', (err) => finish({ error: err.code ?? err.message, durationMs: 0 }))
    socket.on('connect', () => {
      // UEL 包裹查询（真实客户端惯例：先 UEL 进入 PJL 上下文，命令行 CRLF 结束，再 UEL 退出）
      socket.write(`${UEL}${command}\r\n${UEL}\r\n`, 'latin1')
    })
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('latin1')
      // 收到关闭 UEL 即认为响应完成
      if (received.includes(UEL, received.indexOf(UEL) + UEL.length)) {
        finish({ text: received, durationMs: 0 })
      }
    })
    // 部分设备不回 UEL 只回正文+EOF：连接被服务端关闭时也完成
    socket.on('close', () => {
      if (!settled && received.length > 0) finish({ text: received, durationMs: 0 })
      else if (!settled) finish({ error: '连接关闭且无响应', durationMs: 0 })
    })
  })
}

/** 宽容解析响应体：去 UEL → 行 → key="value" / key=value */
function parsePjlResponse(text: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('\x1b')) continue
    const m = /^@?[A-Za-z0-9_]+?\s+([A-Za-z0-9_]+)="(.*)"$/i.exec(line) ?? /^([A-Za-z0-9_]+)="(.*)"$/i.exec(line)
    if (m) {
      map.set(m[1].toUpperCase(), m[2] ?? '')
      continue
    }
    const bare = /^([A-Za-z0-9_]+)=(.+)$/.exec(line)
    if (bare) map.set(bare[1].toUpperCase(), (bare[2] ?? '').trim())
  }
  return map
}

// ---------------------------------------------------------------- 对外探测 API

/** @PJL INFO STATUS 状态回读 */
export async function probePjlStatus(opts: PjlProbeOptions): Promise<PjlStatusResult> {
  const result = await pjlQuery(opts, '@PJL INFO STATUS')
  if ('error' in result) {
    return { ok: false, durationMs: result.durationMs, status: null, message: null, rawCode: null, display: null, error: result.error }
  }
  const fields = parsePjlResponse(result.text)
  const code = fields.get('CODE') ?? null
  const display = fields.get('DISPLAY') ?? null
  if (!code) {
    return { ok: false, durationMs: result.durationMs, status: null, message: null, rawCode: null, display, error: '响应无 CODE 字段' }
  }
  const mapped = CODE_TO_STATUS[code] ?? null
  return {
    ok: true,
    durationMs: result.durationMs,
    status: mapped?.status ?? null,
    message: mapped?.message ?? display,
    rawCode: code,
    display,
  }
}

/** @PJL INFO SUPPLY 耗材回读（Brother 风格试点；失败返回全 unknown 报告） */
export async function probePjlSupply(opts: PjlProbeOptions): Promise<PjlSupplyResult> {
  const result = await pjlQuery(opts, '@PJL INFO SUPPLY')
  if ('error' in result) {
    const report = emptyReport('VENDOR_API', `PJL INFO SUPPLY 探测失败：${result.error}`)
    report.probes.push({ source: 'VENDOR_API', ok: false, durationMs: result.durationMs, error: result.error, at: new Date().toISOString() })
    return { ok: false, durationMs: result.durationMs, report, error: result.error }
  }
  const fields = parsePjlResponse(result.text)
  const supplyName = fields.get('SUPPLY')
  const levelRaw = fields.get('LEVEL')
  const level = levelRaw !== undefined && /^\d+$/.test(levelRaw) ? Number(levelRaw) : null
  if (!supplyName || level === null || level < 0 || level > 100) {
    const report = emptyReport('VENDOR_API', 'PJL INFO SUPPLY 响应无 SUPPLY/LEVEL 或 LEVEL 超出 0-100')
    report.probes.push({ source: 'VENDOR_API', ok: false, durationMs: result.durationMs, error: 'SUPPLY/LEVEL 字段缺失或非法', at: new Date().toISOString() })
    return { ok: false, durationMs: result.durationMs, report, error: 'SUPPLY/LEVEL 字段缺失或非法' }
  }
  const consumable: ConsumableInfo = {
    name: supplyName,
    kind: supplyKindOf(fields.get('TYPE') ?? 'TONER'),
    levelPct: level,
    source: 'VENDOR_API',
  }
  const report = emptyReport('VENDOR_API')
  report.consumables = supportedCap([consumable], 'VENDOR_API', `PJL INFO SUPPLY（RAW :${opts.port}，Brother 风格试点格式）`)
  report.probes.push({ source: 'VENDOR_API', ok: true, durationMs: result.durationMs, at: new Date().toISOString() })
  return { ok: true, durationMs: result.durationMs, report }
}

/** 从任意后端 URI 提取主机名（ipp://host:3061/... → host） */
export function pjlHostFromUri(uri: string): string | null {
  try {
    return new URL(uri).hostname
  } catch {
    return null
  }
}
