import { createSocket, type Socket } from 'node:dgram'
import type { CapabilityProbe, CapabilityReport, ConsumableInfo, PrinterStatus } from '../core/types'
import { emptyReport, failProbe, supportedCap } from './merge'

/**
 * SNMP v1/v2c 探测（RFC 1157 BER 编解码自研，UDP 161，尽力而为）。
 *
 * OID（Printer-MIB RFC 3805）耗材：
 *  - prtMarkerSuppliesLevel       1.3.6.1.2.1.43.11.1.1.9.<idx>（值：-3 unknown / -2 remaining 非精确 / -1..100 百分比）
 *  - prtMarkerSuppliesType        1.3.6.1.2.1.43.11.1.1.5.<idx>（3 toner / 4 ink / 8 drum…）
 *  - prtMarkerSuppliesDescription 1.3.6.1.2.1.43.11.1.1.6.<idx>（字符串）
 *
 * OID（HOST-RESOURCES-MIB RFC 2790）状态（P1 增强：SNMP 作为状态二级来源）：
 *  - hrDeviceType               1.3.6.1.2.1.25.3.2.1.3.<idx>（值=OID；printer 类型为 1.3.6.1.2.1.25.3.1.5）
 *  - hrPrinterStatus            1.3.6.1.2.1.25.3.5.1.1.<idx>（1 other / 2 unknown / 3 idle / 4 printing / 5 warmup）
 *  - hrPrinterDetectedErrorState 1.3.6.1.2.1.25.3.5.1.2.<idx>（OCTET STRING 位掩码：bit0 lowPaper / bit1 noPaper /
 *    bit2 jam / bit3 doorOpen / bit4 inputTrayMissing / bit5 outputTrayMissing / bit6 markerSupplyMissing /
 *    bit7 outputFull / bit8 inputProblem / bit9 outputProblem / bit10 markerSupplyLow / bit11 markerSupplyEmpty）
 *
 * 原则：SNMP 失败绝不影响其它能力与打印可用性 —— 只返回失败 probe，
 * 耗材归 UNKNOWN、状态返回 null（读取不到 ≠ 不支持，不猜测）。
 */

const PRINTER_MIB_SUPPLIES_LEVEL = '1.3.6.1.2.1.43.11.1.1.9'
const PRINTER_MIB_SUPPLIES_TYPE = '1.3.6.1.2.1.43.11.1.1.5'
const PRINTER_MIB_SUPPLIES_DESC = '1.3.6.1.2.1.43.11.1.1.6'
const HR_DEVICE_TYPE = '1.3.6.1.2.1.25.3.2.1.3'
const HR_PRINTER_STATUS = '1.3.6.1.2.1.25.3.5.1.1'
const HR_PRINTER_ERROR_STATE = '1.3.6.1.2.1.25.3.5.1.2'
/** hrDeviceType 值为 OID；printer 设备类型的标准值 */
const HR_DEVICE_PRINTER_OID = '1.3.6.1.2.1.25.3.1.5'

/** hrPrinterDetectedErrorState 位掩码 → 可读名（RFC 2790 TC 定义） */
const HR_ERROR_BITS: Array<{ bit: number; name: string }> = [
  { bit: 0, name: 'lowPaper' },
  { bit: 1, name: 'noPaper' },
  { bit: 2, name: 'jam' },
  { bit: 3, name: 'doorOpen' },
  { bit: 4, name: 'inputTrayMissing' },
  { bit: 5, name: 'outputTrayMissing' },
  { bit: 6, name: 'markerSupplyMissing' },
  { bit: 7, name: 'outputFull' },
  { bit: 8, name: 'inputProblem' },
  { bit: 9, name: 'outputProblem' },
  { bit: 10, name: 'markerSupplyLow' },
  { bit: 11, name: 'markerSupplyEmpty' },
]

export interface SnmpProbeOptions {
  host: string
  port?: number
  community?: string
  timeoutMs?: number
  retries?: number
}

export interface SnmpProbeResult {
  report: CapabilityReport
  probe: CapabilityProbe
  consumables: ConsumableInfo[]
}

// ---------------------------------------------------------------- BER 编码

class BerWriter {
  private chunks: Buffer[] = []
  private length = 0

  private push(chunk: Buffer): void {
    this.chunks.push(chunk)
    this.length += chunk.length
  }

  private tlv(tag: number, content: Buffer): void {
    const len = content.length
    let lenBytes: Buffer
    if (len < 0x80) {
      lenBytes = Buffer.from([len])
    } else {
      const bytes: number[] = []
      let v = len
      while (v > 0) {
        bytes.unshift(v & 0xff)
        v = Math.floor(v / 256)
      }
      lenBytes = Buffer.from([0x80 | bytes.length, ...bytes])
    }
    this.push(Buffer.from([tag]))
    this.push(lenBytes)
    this.push(content)
  }

  integer(value: number): void {
    // 有符号补码（SNMP INTEGER 可为负，如 prtMarkerSuppliesLevel=-3）
    const buf = Buffer.alloc(4)
    buf.writeInt32BE(value, 0)
    this.tlv(0x02, buf)
  }

  octetString(value: string | Buffer): void {
    const content = typeof value === 'string' ? Buffer.from(value, 'utf8') : value
    this.tlv(0x04, content)
  }

  null(): void {
    this.tlv(0x05, Buffer.alloc(0))
  }

  oid(value: string): void {
    const parts = value.split('.').map((p) => parseInt(p, 10))
    if (parts.length < 2) throw new Error(`非法 OID：${value}`)
    const bytes: number[] = [parts[0]! * 40 + parts[1]!]
    for (const part of parts.slice(2)) {
      if (part < 0) throw new Error(`非法 OID（负数段）：${value}`)
      if (part < 0x80) {
        bytes.push(part)
      } else {
        // base-128 变长编码
        const stack: number[] = [part & 0x7f]
        let v = Math.floor(part / 128)
        while (v > 0) {
          stack.unshift((v & 0x7f) | 0x80)
          v = Math.floor(v / 128)
        }
        bytes.push(...stack)
      }
    }
    this.tlv(0x06, Buffer.from(bytes))
  }

  sequence(children: (w: BerWriter) => void): void {
    const inner = new BerWriter()
    children(inner)
    this.tlv(0x30, inner.build())
  }

  contextPdu(tag: number, children: (w: BerWriter) => void): void {
    const inner = new BerWriter()
    children(inner)
    this.tlv(0xa0 | tag, inner.build())
  }

  build(): Buffer {
    return Buffer.concat(this.chunks)
  }

  get size(): number {
    return this.length
  }
}

/** GetRequest (a0) / GetNextRequest (a1) PDU */
function encodeSnmpRequest(pduTag: 0x00 | 0x01, requestId: number, community: string, oids: string[]): Buffer {
  const outer = new BerWriter()
  outer.sequence((w) => {
    w.integer(0) // SNMPv1
    w.octetString(community)
    w.contextPdu(pduTag, (p) => {
      p.integer(requestId)
      p.integer(0) // error-status
      p.integer(0) // error-index
      p.sequence((vb) => {
        for (const oid of oids) {
          vb.sequence((pair) => {
            pair.oid(oid)
            pair.null()
          })
        }
      })
    })
  })
  return outer.build()
}

// ---------------------------------------------------------------- BER 解码

interface BerTlv {
  tag: number
  content: Buffer
}

class BerReader {
  private pos = 0

  constructor(private readonly buf: Buffer) {}

  private assert(n: number): void {
    if (this.pos + n > this.buf.length) throw new Error(`BER 解码越界（需 ${n} @${this.pos}，共 ${this.buf.length}）`)
  }

  readTlv(): BerTlv {
    this.assert(1)
    const tag = this.buf[this.pos++]!
    this.assert(1)
    let len = this.buf[this.pos++]!
    if (len & 0x80) {
      const numBytes = len & 0x7f
      this.assert(numBytes)
      len = 0
      for (let i = 0; i < numBytes; i++) len = len * 256 + this.buf[this.pos++]!
    }
    this.assert(len)
    const content = this.buf.subarray(this.pos, this.pos + len)
    this.pos += len
    return { tag, content }
  }

  eof(): boolean {
    return this.pos >= this.buf.length
  }
}

function readIntContent(content: Buffer): number {
  // 有符号 BER INTEGER（可变长 1-4 字节）
  if (content.length === 0) return 0
  let value = content[0]! & 0x80 ? -1 : 0
  for (const byte of content) {
    value = (value << 8) | byte
  }
  return value | 0
}

function decodeOid(content: Buffer): string {
  if (content.length === 0) return ''
  const parts: number[] = []
  const first = content[0]!
  parts.push(Math.floor(first / 40), first % 40)
  let value = 0
  for (const byte of content.subarray(1)) {
    value = (value << 7) | (byte & 0x7f)
    if ((byte & 0x80) === 0) {
      parts.push(value)
      value = 0
    }
  }
  return parts.join('.')
}

interface SnmpVarBind {
  oid: string
  value:
    | { kind: 'int'; value: number }
    | { kind: 'string'; value: string; raw?: Buffer }
    | { kind: 'oid'; value: string }
    | { kind: 'null' }
    | { kind: 'other' }
}

interface SnmpResponse {
  requestId: number
  errorStatus: number
  errorIndex: number
  varbinds: SnmpVarBind[]
}

function decodeSnmpResponse(buf: Buffer): SnmpResponse {
  const r = new BerReader(buf)
  const message = r.readTlv()
  if (message.tag !== 0x30) throw new Error('SNMP 响应不是 SEQUENCE')
  const inner = new BerReader(message.content)
  // version
  const version = inner.readTlv()
  if (version.tag !== 0x02) throw new Error('SNMP version 缺失')
  // community
  const community = inner.readTlv()
  if (community.tag !== 0x04) throw new Error('SNMP community 缺失')
  // PDU（GetResponse = a2）
  const pdu = inner.readTlv()
  if (pdu.tag !== 0xa2) throw new Error(`不是 GetResponse PDU（tag=0x${pdu.tag.toString(16)}）`)
  const pduReader = new BerReader(pdu.content)
  const requestId = readIntContent(pduReader.readTlv().content)
  const errorStatus = readIntContent(pduReader.readTlv().content)
  const errorIndex = readIntContent(pduReader.readTlv().content)
  const varbindList = pduReader.readTlv()
  if (varbindList.tag !== 0x30) throw new Error('varbind list 缺失')
  const vbReader = new BerReader(varbindList.content)
  const varbinds: SnmpVarBind[] = []
  while (!vbReader.eof()) {
    const pair = vbReader.readTlv()
    if (pair.tag !== 0x30) continue
    const pairReader = new BerReader(pair.content)
    const oidTlv = pairReader.readTlv()
    if (oidTlv.tag !== 0x06) continue
    const oid = decodeOid(oidTlv.content)
    const valueTlv = pairReader.readTlv()
    let value: SnmpVarBind['value']
    if (valueTlv.tag === 0x02) value = { kind: 'int', value: readIntContent(valueTlv.content) }
    else if (valueTlv.tag === 0x04) value = { kind: 'string', value: valueTlv.content.toString('utf8'), raw: valueTlv.content }
    else if (valueTlv.tag === 0x06) value = { kind: 'oid', value: decodeOid(valueTlv.content) }
    else if (valueTlv.tag === 0x05) value = { kind: 'null' }
    else value = { kind: 'other' }
    varbinds.push({ oid, value })
  }
  return { requestId, errorStatus, errorIndex, varbinds }
}

// ---------------------------------------------------------------- OID 工具

function oidWithin(oid: string, base: string): boolean {
  return oid === base || oid.startsWith(`${base}.`)
}

function oidIndex(oid: string, base: string): string | null {
  if (!oid.startsWith(`${base}.`)) return null
  return oid.slice(base.length + 1)
}

// ---------------------------------------------------------------- UDP 请求

interface UdpRequestResult {
  buffer: Buffer
  ms: number
}

function udpRequest(host: string, port: number, payload: Buffer, timeoutMs: number, retries: number): Promise<UdpRequestResult> {
  return new Promise((resolve, reject) => {
    const socket: Socket = createSocket({ type: 'udp4' })
    let attempts = 0
    let settled = false
    const startAt = Date.now()
    const cleanup = (): void => {
      socket.close()
    }
    const attempt = (): void => {
      attempts += 1
      socket.send(payload, port, host, (err) => {
        if (err) {
          if (!settled) {
            settled = true
            cleanup()
            reject(err)
          }
          return
        }
        const timer = setTimeout(() => {
          if (settled) return
          if (attempts > retries) {
            settled = true
            cleanup()
            reject(new Error(`SNMP 无响应（${host}:${port}，${attempts} 次尝试 × ${timeoutMs}ms 超时）`))
          } else {
            attempt()
          }
        }, timeoutMs)
        socket.once('message', (buf) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          cleanup()
          resolve({ buffer: buf, ms: Date.now() - startAt })
        })
      })
    }
    socket.on('error', (err) => {
      if (!settled) {
        settled = true
        cleanup()
        reject(err)
      }
    })
    attempt()
  })
}

/** SNMP v1 GetNext 单次请求 */
async function snmpGetNext(host: string, port: number, community: string, oid: string, timeoutMs: number, retries: number): Promise<SnmpVarBind> {
  const requestId = (Math.random() * 0x7fffffff) | 0
  const payload = encodeSnmpRequest(0x01, requestId, community, [oid])
  const { buffer } = await udpRequest(host, port, payload, timeoutMs, retries)
  const response = decodeSnmpResponse(buffer)
  if (response.errorStatus !== 0) {
    throw new Error(`SNMP error-status=${response.errorStatus}（error-index=${response.errorIndex}）`)
  }
  const vb = response.varbinds[0]
  if (!vb) throw new Error('SNMP 响应无 varbind')
  return vb
}

/** SNMP v1 GetRequest 精确读取（多 OID 单次往返；varbind 顺序与请求一致） */
async function snmpGet(host: string, port: number, community: string, oids: string[], timeoutMs: number, retries: number): Promise<SnmpVarBind[]> {
  const requestId = (Math.random() * 0x7fffffff) | 0
  const payload = encodeSnmpRequest(0x00, requestId, community, oids)
  const { buffer } = await udpRequest(host, port, payload, timeoutMs, retries)
  const response = decodeSnmpResponse(buffer)
  if (response.errorStatus !== 0) {
    throw new Error(`SNMP error-status=${response.errorStatus}（error-index=${response.errorIndex}）`)
  }
  return response.varbinds
}

/** GetNext walk 列举某 OID 子树（最多 maxEntries 条） */
async function snmpWalk(host: string, port: number, community: string, baseOid: string, opts: SnmpProbeOptions): Promise<Map<string, SnmpVarBind>> {
  const results = new Map<string, SnmpVarBind>()
  let current = baseOid
  for (let i = 0; i < 40; i++) {
    const vb = await snmpGetNext(host, port, community, current, opts.timeoutMs ?? 900, opts.retries ?? 1)
    if (!oidWithin(vb.oid, baseOid)) break // 走出子树
    results.set(vb.oid, vb)
    current = vb.oid
  }
  return results
}

/** prtMarkerSuppliesType 枚举 → ConsumableInfo.kind */
function supplyKindOf(typeValue: number): ConsumableInfo['kind'] {
  // RFC 3805 prtMarkerSuppliesType TC: 3=toner 4=ink 5=... 8=other? 常见映射如下（尽力而为）
  switch (typeValue) {
    case 3:
      return 'toner'
    case 4:
      return 'ink'
    case 5:
    case 6:
      return 'other'
    case 7:
      return 'drum' // opc/photoconductor
    case 9:
      return 'maintenance-kit' // fuser
    default:
      return 'other'
  }
}

/**
 * 探测打印机耗材（marker supplies）。失败时返回全 unknown 报告 + 失败 probe ——
 * 绝不影响其它能力与打印（协议失败 ≠ 打印机不可用）。
 */
export async function probeSnmpConsumables(opts: SnmpProbeOptions): Promise<SnmpProbeResult> {
  const startedAt = Date.now()
  const host = opts.host
  const port = opts.port ?? 161
  const community = opts.community ?? 'public'
  try {
    const [levels, types, descs] = await Promise.all([
      snmpWalk(host, port, community, PRINTER_MIB_SUPPLIES_LEVEL, opts),
      snmpWalk(host, port, community, PRINTER_MIB_SUPPLIES_TYPE, opts),
      snmpWalk(host, port, community, PRINTER_MIB_SUPPLIES_DESC, opts),
    ])
    const consumables: ConsumableInfo[] = []
    for (const [oid, vb] of levels) {
      const idx = oidIndex(oid, PRINTER_MIB_SUPPLIES_LEVEL)
      if (!idx) continue
      if (vb.value.kind !== 'int') continue
      const raw = vb.value.value
      // 语义：-3 unknown、-2 remaining（非精确）、-1..100 百分比
      const levelPct = raw >= 0 && raw <= 100 ? raw : null
      // 对应 type / description（同索引）
      let typeValue = 0
      for (const [tOid, tVb] of types) {
        if (oidIndex(tOid, PRINTER_MIB_SUPPLIES_TYPE) === idx && tVb.value.kind === 'int') typeValue = tVb.value.value
      }
      let name = `Supply ${idx}`
      for (const [dOid, dVb] of descs) {
        if (oidIndex(dOid, PRINTER_MIB_SUPPLIES_DESC) === idx && dVb.value.kind === 'string' && dVb.value.value.trim() !== '') {
          name = dVb.value.value.trim()
        }
      }
      consumables.push({
        name: name.slice(0, 120),
        kind: supplyKindOf(typeValue),
        levelPct,
        source: 'SNMP',
      })
    }
    const durationMs = Date.now() - startedAt
    const report = emptyReport('SNMP')
    report.consumables =
      consumables.length > 0
        ? supportedCap(consumables, 'SNMP', `Printer-MIB prtMarkerSuppliesLevel × ${consumables.length}`)
        : report.consumables
    report.probes.push({ source: 'SNMP', ok: true, durationMs, at: new Date().toISOString() })
    return { report, probe: { source: 'SNMP', ok: true, durationMs, at: new Date().toISOString() }, consumables }
  } catch (err) {
    const durationMs = Date.now() - startedAt
    const message = err instanceof Error ? err.message : String(err)
    const probe = failProbe('SNMP', durationMs, message)
    const report = emptyReport('SNMP', `SNMP 探测失败：${message}`)
    report.probes.push(probe)
    return { report, probe, consumables: [] }
  }
}

/** hrPrinterDetectedErrorState 位掩码字节 → 条件名列表（字节精确解析，经 raw Buffer） */
export function parseHrErrorBits(raw: Buffer | undefined, value: string): string[] {
  const bytes = raw ?? Buffer.from(value, 'latin1')
  const conditions: string[] = []
  for (const { bit, name } of HR_ERROR_BITS) {
    const byte = bytes[Math.floor(bit / 8)]
    if (byte !== undefined && (byte & (1 << (bit % 8))) !== 0) conditions.push(name)
  }
  return conditions
}

/** hrPrinterStatus 枚举值 → 文本 */
function hrPrinterStatusText(v: number): string {
  switch (v) {
    case 1:
      return 'other'
    case 2:
      return 'unknown'
    case 3:
      return 'idle'
    case 4:
      return 'printing'
    case 5:
      return 'warmup'
    default:
      return `hrPrinterStatus=${v}`
  }
}

export interface SnmpStatusResult {
  /** null = 读取失败/无打印机设备（绝不能猜测） */
  status: PrinterStatus | null
  message: string
  conditions: string[]
  probe: CapabilityProbe
}

/**
 * 探测打印机运行状态（HOST-RESOURCES-MIB）。
 * 步骤：walk hrDeviceType 找到 printer 类型设备索引 → GetRequest 读取 hrPrinterStatus + hrPrinterDetectedErrorState。
 * 失败时 status=null（调用方保持原状态不动）——SNMP 失败绝不影响打印可用性。
 */
export async function probeSnmpStatus(opts: SnmpProbeOptions): Promise<SnmpStatusResult> {
  const startedAt = Date.now()
  const host = opts.host
  const port = opts.port ?? 161
  const community = opts.community ?? 'public'
  const timeoutMs = opts.timeoutMs ?? 900
  const retries = opts.retries ?? 1
  const fail = (message: string): SnmpStatusResult => {
    const probe = failProbe('SNMP', Date.now() - startedAt, message)
    return { status: null, message: `SNMP 状态探测失败：${message}`, conditions: [], probe }
  }
  try {
    // 1) 找 printer 设备索引（hrDeviceType 值 = 1.3.6.1.2.1.25.3.1.5）
    const deviceTypes = await snmpWalk(host, port, community, HR_DEVICE_TYPE, opts)
    const printerIndices: string[] = []
    for (const [oid, vb] of deviceTypes) {
      if (vb.value.kind === 'oid' && oidWithin(vb.value.value, HR_DEVICE_PRINTER_OID)) {
        const idx = oidIndex(oid, HR_DEVICE_TYPE)
        if (idx) printerIndices.push(idx)
      }
    }
    if (printerIndices.length === 0) {
      // 读取成功但没有 printer 设备 —— 如实返回，不猜测
      return {
        status: null,
        message: 'SNMP HOST-RESOURCES 未发现 printer 类型设备（hrDeviceType 无 25.3.1.5）',
        conditions: [],
        probe: { source: 'SNMP', ok: true, durationMs: Date.now() - startedAt, at: new Date().toISOString() },
      }
    }
    // 2) 读取第一台 printer 的状态 + 错误位掩码（多 OID 单次往返）
    const idx = printerIndices[0]!
    const [vbs] = await Promise.all([
      snmpGet(host, port, community, [`${HR_PRINTER_STATUS}.${idx}`, `${HR_PRINTER_ERROR_STATE}.${idx}`], timeoutMs, retries),
    ])
    let hrStatus = 0
    let errorRaw: Buffer | undefined
    let errorStr = ''
    for (const vb of vbs) {
      if (oidWithin(vb.oid, `${HR_PRINTER_STATUS}.${idx}`) && vb.value.kind === 'int') hrStatus = vb.value.value
      if (oidWithin(vb.oid, `${HR_PRINTER_ERROR_STATE}.${idx}`) && vb.value.kind === 'string') {
        errorRaw = vb.value.raw
        errorStr = vb.value.value
      }
    }
    const conditions = parseHrErrorBits(errorRaw, errorStr)
    const durationMs = Date.now() - startedAt
    const probe: CapabilityProbe = { source: 'SNMP', ok: true, durationMs, at: new Date().toISOString() }
    const statusText = hrPrinterStatusText(hrStatus)
    // 3) 位掩码条件 → OPS PrinterStatus 映射（优先级：硬条件 > 运行态）
    if (conditions.includes('noPaper') || conditions.includes('lowPaper')) {
      return { status: 'paper-out', message: `SNMP hrPrinterDetectedErrorState=${conditions.join(',')}（缺纸）`, conditions, probe }
    }
    if (conditions.includes('jam')) {
      return { status: 'paper-jam', message: `SNMP hrPrinterDetectedErrorState=${conditions.join(',')}（卡纸）`, conditions, probe }
    }
    const hardErrors = conditions.filter((c) => !['markerSupplyLow', 'markerSupplyEmpty'].includes(c))
    if (hardErrors.length > 0) {
      return { status: 'error', message: `SNMP hrPrinterDetectedErrorState=${conditions.join(',')}`, conditions, probe }
    }
    // 仅耗材告警 → 保持运行态 + 告警附加
    const supplyWarn = conditions.filter((c) => c.startsWith('markerSupply'))
    const warnSuffix = supplyWarn.length > 0 ? `（耗材告警：${supplyWarn.join(',')}）` : ''
    if (hrStatus === 4) return { status: 'busy', message: `SNMP hrPrinterStatus=printing${warnSuffix}`, conditions, probe }
    if (hrStatus === 3 || hrStatus === 5) return { status: 'online', message: `SNMP hrPrinterStatus=${statusText}${warnSuffix}`, conditions, probe }
    // hrStatus other(1)/unknown(2)/读不到 → 状态未知，不覆盖
    return { status: null, message: `SNMP hrPrinterStatus=${statusText}（状态不可映射，保持原状态）`, conditions, probe }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }
}

/** 从 IPP URI 提取 SNMP host（ipps/ipps 不支持 TLS，故取 ipp/http 的 host） */
export function snmpHostFromUri(uri: string): string | null {
  try {
    return new URL(uri).hostname
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- BER 编码自测导出（供测试使用）

export const _internal = { encodeSnmpRequest, decodeSnmpResponse, readIntContent, decodeOid, parseHrErrorBits }
