import { createSocket, type Socket } from 'node:dgram'
import type { CapabilityProbe, CapabilityReport, ConsumableInfo } from '../core/types'
import { emptyReport, failProbe, supportedCap } from './merge'

/**
 * SNMP v1 探测（RFC 1157 BER 编解码自研，UDP 161，尽力而为）。
 *
 * OID（Printer-MIB RFC 3805）：
 *  - prtMarkerSuppliesLevel       1.3.6.1.2.1.43.11.1.1.9.<idx>（值：-3 unknown / -2 remaining 非精确 / -1..100 百分比）
 *  - prtMarkerSuppliesType        1.3.6.1.2.1.43.11.1.1.5.<idx>（3 toner / 4 ink / 8 drum…）
 *  - prtMarkerSuppliesDescription 1.3.6.1.2.1.43.11.1.1.6.<idx>（字符串）
 *
 * 原则：SNMP 失败绝不影响其它能力与打印可用性 —— 只返回失败 probe，
 * 耗材归 UNKNOWN（读取不到 ≠ 不支持）。
 */

const PRINTER_MIB_SUPPLIES_LEVEL = '1.3.6.1.2.1.43.11.1.1.9'
const PRINTER_MIB_SUPPLIES_TYPE = '1.3.6.1.2.1.43.11.1.1.5'
const PRINTER_MIB_SUPPLIES_DESC = '1.3.6.1.2.1.43.11.1.1.6'

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
  value: { kind: 'int'; value: number } | { kind: 'string'; value: string } | { kind: 'null' } | { kind: 'other' }
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
    else if (valueTlv.tag === 0x04) value = { kind: 'string', value: valueTlv.content.toString('utf8') }
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

/** 从 IPP URI 提取 SNMP host（ipps/ipps 不支持 TLS，故取 ipp/http 的 host） */
export function snmpHostFromUri(uri: string): string | null {
  try {
    return new URL(uri).hostname
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- BER 编码自测导出（供测试使用）

export const _internal = { encodeSnmpRequest, decodeSnmpResponse, readIntContent, decodeOid }
