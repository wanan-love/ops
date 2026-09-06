import { createSocket, type Socket } from 'node:dgram'
import { networkInterfaces } from 'node:os'
import type { DiscoveredIpPrinter } from '../core/types'
import type { EventBus } from '../core/eventbus'
import type { EventLog } from '../core/eventlog'
import type { VirtualIppServer } from '../vipp/server'
import type { VirtualScanServer } from '../vscan/server'

/**
 * mDNS 发现（纯 TypeScript UDP，RFC 6762/mDNS + DNS 压缩名解析）。
 *
 *  - MdnsService：单 socket（组播 224.0.0.251:5353）同时承担浏览器与通告器
 *    · 浏览：发送 PTR 查询（_ipp._tcp.local / _universal._sub._ipp._tcp.local / _pdl-datastream._tcp.local），
 *      2s 窗口收集响应 → PTR→SRV(host,port)→TXT(rp/ty/pdl)→A(ip) 聚合为 DiscoveredIpPrinter
 *    · 通告：Virtual IPP Server 自通告 _ipp._tcp.local（4 个实例，TXT rp=printers/<id>，端口 3061）
 *      响应查询 + 周期 30s announce（组播 TTL 255）—— 同机回环 browser 能发现自己
 *  - 降级：socket bind 失败/权限错误 → 记录事件并返回空列表 + 说明（不抛错）
 */

const MDNS_GROUP = '224.0.0.251'
const MDNS_PORT = 5353
const SCAN_WINDOW_MS = 2000
const ANNOUNCE_INTERVAL_MS = 30_000

/** DNS 记录类型 */
const TYPE_PTR = 12
const TYPE_A = 1
const TYPE_SRV = 33
const TYPE_TXT = 16

const IPP_SERVICE = '_ipp._tcp.local'
const IPPS_SERVICE = '_ipps._tcp.local'
const USCAN_SERVICE = '_uscan._tcp.local'
const QUERIED_SERVICES = ['_ipp._tcp.local', '_ipps._tcp.local', '_universal._sub._ipp._tcp.local', '_pdl-datastream._tcp.local', '_uscan._tcp.local']

// ---------------------------------------------------------------- DNS 编码

function encodeName(name: string): Buffer {
  // 支持 "label.sub._tcp.local" 形式；'\\.' 转义不处理（mDNS 服务名无需）
  const labels = name.split('.').filter((l) => l !== '')
  const parts: number[] = []
  for (const label of labels) {
    const bytes = Buffer.from(label, 'utf8')
    if (bytes.length > 63) throw new Error(`DNS 标签过长：${label}`)
    parts.push(bytes.length, ...bytes)
  }
  parts.push(0)
  return Buffer.from(parts)
}

/** mDNS 查询（id=0，flags=0x0000 标准查询） */
function encodeQuery(questions: Array<{ name: string; type: number }>): Buffer {
  const qdcount = questions.length
  const header = Buffer.alloc(12)
  header.writeUInt16BE(0, 0)
  header.writeUInt16BE(0x0000, 2)
  header.writeUInt16BE(qdcount, 4)
  header.writeUInt16BE(0, 6)
  header.writeUInt16BE(0, 8)
  header.writeUInt16BE(0, 10)
  const parts: Buffer[] = [header]
  for (const q of questions) {
    parts.push(encodeName(q.name))
    const tail = Buffer.alloc(4)
    tail.writeUInt16BE(q.type, 0)
    tail.writeUInt16BE(1, 2) // class IN
    parts.push(tail)
  }
  return Buffer.concat(parts)
}

// ---------------------------------------------------------------- DNS 解码（含压缩指针）

class DnsReader {
  private pos = 0

  constructor(private readonly buf: Buffer) {}

  u16(): number {
    if (this.pos + 2 > this.buf.length) throw new Error('DNS 解码越界（u16）')
    const v = this.buf.readUInt16BE(this.pos)
    this.pos += 2
    return v
  }

  u32(): number {
    if (this.pos + 4 > this.buf.length) throw new Error('DNS 解码越界（u32）')
    const v = this.buf.readUInt32BE(this.pos)
    this.pos += 4
    return v
  }

  u8(): number {
    if (this.pos + 1 > this.buf.length) throw new Error('DNS 解码越界（u8）')
    return this.buf[this.pos++]!
  }

  bytes(n: number): Buffer {
    if (this.pos + n > this.buf.length) throw new Error('DNS 解码越界（bytes）')
    const out = this.buf.subarray(this.pos, this.pos + n)
    this.pos += n
    return out
  }

  rest(): Buffer {
    return this.buf.subarray(this.pos)
  }

  /** 读域名（支持 0xC0 压缩指针） */
  name(): string {
    const labels: string[] = []
    let pos = this.pos
    let jumped = false
    let guard = 0
    for (;;) {
      if (guard++ > 128) throw new Error('DNS 名解析循环过量（压缩指针异常）')
      if (pos >= this.buf.length) throw new Error('DNS 名解析越界')
      const len = this.buf[pos]!
      if (len === 0) {
        pos += 1
        break
      }
      if ((len & 0xc0) === 0xc0) {
        // 压缩指针
        const ptr = ((len & 0x3f) << 8) | (pos + 1 < this.buf.length ? this.buf[pos + 1]! : 0)
        if (!jumped) {
          this.pos = pos + 2 // 消费指针后，外层继续位置在指针处
          jumped = true
        }
        pos = ptr
        continue
      }
      if (pos + 1 + len > this.buf.length) throw new Error('DNS 名标签越界')
      labels.push(this.buf.subarray(pos + 1, pos + 1 + len).toString('utf8'))
      pos += 1 + len
      if (!jumped) this.pos = pos
    }
    if (!jumped) this.pos = pos
    return labels.join('.')
  }

  get offset(): number {
    return this.pos
  }

  set offset(v: number) {
    this.pos = v
  }
}

interface DnsRecord {
  name: string
  type: number
  class: number
  ttl: number
  rdata: Buffer
}

interface DnsQuestion {
  name: string
  type: number
}

interface DnsPacket {
  isResponse: boolean
  questions: DnsQuestion[]
  answers: DnsRecord[]
  additionals: DnsRecord[]
}

function decodeDnsPacket(buf: Buffer): DnsPacket {
  const r = new DnsReader(buf)
  r.u16() // id（mDNS 固定 0）
  const flags = r.u16()
  const qdcount = r.u16()
  const ancount = r.u16()
  const nscount = r.u16()
  const arcount = r.u16()
  const isResponse = (flags & 0x8000) !== 0
  const questions: DnsQuestion[] = []
  for (let i = 0; i < qdcount; i++) {
    const name = r.name()
    const type = r.u16()
    r.u16() // class
    questions.push({ name, type })
  }
  const readRecords = (count: number): DnsRecord[] => {
    const records: DnsRecord[] = []
    for (let i = 0; i < count; i++) {
      const name = r.name()
      const type = r.u16()
      const cls = r.u16()
      const ttl = r.u32()
      const rdlength = r.u16()
      const rdata = r.bytes(rdlength)
      records.push({ name, type, class: cls, ttl, rdata })
    }
    return records
  }
  const answers = readRecords(ancount)
  const authorities = readRecords(nscount)
  const additionals = readRecords(arcount)
  return { isResponse, questions, answers, additionals: [...additionals, ...authorities] }
}

/** rdata 里读域名（压缩指针可指向整个报文） */
function readNameInRecord(buf: Buffer, offset: number): string {
  const r = new DnsReader(buf)
  r.offset = offset
  return r.name()
}

/** SRV rdata：priority(2) weight(2) port(2) target(name) */
function parseSrv(buf: Buffer): { port: number; target: string } {
  const port = buf.readUInt16BE(4)
  const target = readNameInRecord(buf, 6)
  return { port, target }
}

/** PTR rdata：指向的域名（可压缩） */
function parsePtr(buf: Buffer): string {
  return readNameInRecord(buf, 0)
}

/** TXT rdata：length-prefixed key[=value] 序列 */
function parseTxt(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  let pos = 0
  while (pos < buf.length) {
    const len = buf[pos]!
    if (len === 0) {
      pos += 1
      continue
    }
    const entry = buf.subarray(pos + 1, pos + 1 + len).toString('utf8')
    pos += 1 + len
    const eq = entry.indexOf('=')
    if (eq > 0) out[entry.slice(0, eq)] = entry.slice(eq + 1)
    else if (eq === -1) out[entry] = ''
  }
  return out
}

// ---------------------------------------------------------------- 响应构造（通告器）

function encodeRecord(name: string, type: number, ttl: number, rdata: Buffer): Buffer {
  const parts: Buffer[] = [encodeName(name)]
  const head = Buffer.alloc(10)
  head.writeUInt16BE(type, 0)
  head.writeUInt16BE(1, 2) // cache-flush 不置位（组播友好）
  head.writeUInt32BE(ttl, 4)
  head.writeUInt16BE(rdata.length, 8)
  parts.push(head, rdata)
  return Buffer.concat(parts)
}

function srvRdata(port: number, target: string): Buffer {
  const targetName = encodeName(target)
  const head = Buffer.alloc(6)
  head.writeUInt16BE(0, 0) // priority
  head.writeUInt16BE(0, 2) // weight
  head.writeUInt16BE(port, 4)
  return Buffer.concat([head, targetName])
}

function txtRdata(txt: Record<string, string>): Buffer {
  const parts: Buffer[] = []
  for (const [key, value] of Object.entries(txt)) {
    const entry = Buffer.from(`${key}=${value}`, 'utf8')
    parts.push(Buffer.from([Math.min(255, entry.length)]), entry)
  }
  if (parts.length === 0) parts.push(Buffer.from([0]))
  return Buffer.concat(parts)
}

function encodeResponse(records: DnsRecord[]): Buffer {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(0, 0)
  header.writeUInt16BE(0x8400, 2) // response + authoritative answer
  header.writeUInt16BE(0, 4) // qdcount
  header.writeUInt16BE(records.length, 6)
  header.writeUInt16BE(0, 8)
  header.writeUInt16BE(0, 10)
  const parts: Buffer[] = [header]
  for (const record of records) {
    parts.push(encodeRecord(record.name, record.type, record.ttl, record.rdata))
  }
  return Buffer.concat(parts)
}

// ---------------------------------------------------------------- MdnsService

export interface MdnsServiceOptions {
  bus: EventBus
  log: EventLog
  /** Virtual IPP Server（通告其打印机；null = 只浏览不通告） */
  vipp: VirtualIppServer | null
  /** Virtual eSCL Scanner（以 _uscan._tcp 通告其扫描仪；null/缺省 = 不通告） */
  vscan?: VirtualScanServer | null
  /** 通告的 TXT 扩展（默认含 note） */
  instanceNamePrefix?: string
}

interface ServiceInstance {
  instanceName: string // "OPS Virtual IPP Full._ipp._tcp.local"
  ptrName: string
  host: string
  port: number
  txt: Record<string, string>
}

export class MdnsService {
  private socket: Socket | null = null
  private announceTimer: ReturnType<typeof setInterval> | null = null
  private available = false
  private collectBuffer: DnsPacket[] | null = null
  private lastScan: DiscoveredIpPrinter[] = []
  private lastScanAt: string | null = null
  private lastScanNote = ''
  private hostname: string

  constructor(private readonly opts: MdnsServiceOptions) {
    this.hostname = `ops-vipp-${Math.random().toString(36).slice(2, 8)}.local`
  }

  start(): void {
    try {
      const socket = createSocket({ type: 'udp4', reuseAddr: true })
      socket.on('error', (err) => {
        this.available = false
        this.opts.log.record({ type: 'discovery', topic: 'mdns', message: `mDNS socket 错误（降级为不可用）：${err.message}` })
        try {
          socket.close()
        } catch {
          /* noop */
        }
        if (this.socket === socket) this.socket = null
      })
      socket.on('message', (buf) => this.onMessage(buf))
      socket.bind(MDNS_PORT, () => {
        try {
          socket.addMembership(MDNS_GROUP)
          socket.setMulticastTTL(255)
          socket.setMulticastLoopback(true) // 同机回环验证：browser 能发现 advertiser
        } catch (err) {
          this.opts.log.record({ type: 'discovery', topic: 'mdns', message: `mDNS 组播成员加入失败：${err instanceof Error ? err.message : String(err)}` })
        }
        this.available = true
        this.socket = socket
        console.log(`[mdns] 服务已启动（组播 ${MDNS_GROUP}:${MDNS_PORT}，主机名 ${this.hostname}）`)
        this.opts.log.record({ type: 'discovery', topic: 'mdns', message: `mDNS 服务已启动（${MDNS_GROUP}:${MDNS_PORT}）` })
        if (this.opts.vipp || this.opts.vscan) {
          this.announce()
          this.announceTimer = setInterval(() => this.announce(), ANNOUNCE_INTERVAL_MS)
        }
      })
    } catch (err) {
      // 降级：权限/环境不允许 → 记录事件，不抛错
      const message = err instanceof Error ? err.message : String(err)
      this.available = false
      this.lastScanNote = `mDNS socket 初始化失败：${message}`
      this.opts.log.record({ type: 'discovery', topic: 'mdns', message: `mDNS 不可用（降级）：${message}` })
    }
  }

  stop(): void {
    if (this.announceTimer) clearInterval(this.announceTimer)
    this.announceTimer = null
    this.socket?.close()
    this.socket = null
    this.available = false
  }

  isAvailable(): boolean {
    return this.available && this.socket !== null
  }

  note(): string {
    return this.lastScanNote
  }

  lastResults(): { printers: DiscoveredIpPrinter[]; at: string | null; note: string } {
    return { printers: this.lastScan, at: this.lastScanAt, note: this.lastScanNote }
  }

  /** 扫描（2s 窗口收集；返回聚合结果 —— 仅打印机类服务，扫描仪由 scanUscan 返回） */
  async scan(windowMs = SCAN_WINDOW_MS): Promise<DiscoveredIpPrinter[]> {
    if (!this.isAvailable() || !this.socket) {
      this.lastScan = []
      this.lastScanNote = this.lastScanNote || 'mDNS 不可用（socket 未绑定）'
      return []
    }
    this.collectBuffer = []
    // 发送 PTR 查询（含已知服务子类型 + _uscan 扫描仪；聚合时打印列表会过滤掉扫描仪）
    const questions = QUERIED_SERVICES.map((name) => ({ name, type: TYPE_PTR }))
    const query = encodeQuery(questions)
    try {
      this.socket.send(query, MDNS_PORT, MDNS_GROUP)
    } catch (err) {
      this.lastScanNote = `mDNS 查询发送失败：${err instanceof Error ? err.message : String(err)}`
      this.collectBuffer = null
      return []
    }
    await new Promise((resolve) => setTimeout(resolve, windowMs))
    const packets = this.collectBuffer ?? []
    this.collectBuffer = null
    const printers = aggregate(packets, 'printers')
    this.lastScan = printers
    this.lastScanAt = new Date().toISOString()
    this.lastScanNote = printers.length > 0 ? `发现 ${printers.length} 台 IPP 打印机（含本机 Virtual IPP 通告）` : '窗口期内未收到 mDNS 响应（可能是组播被环境禁用，或网段内无 IPP 设备）'
    this.opts.bus.emit('discovery:update', { hosts: [] })
    this.opts.log.record({ type: 'discovery', topic: 'mdns', message: `mDNS 扫描完成：${printers.length} 台（${printers.map((p) => p.name).join('、') || '无'}）` })
    return printers
  }

  /**
   * 扫描 _uscan._tcp（eSCL/AirScan 扫描仪；P3）。
   * 与 scan() 共用 collectBuffer（互斥：同时只允许一个在跑）；
   * 独立聚合 —— 只保留 _uscan 实例，uri 填 http://{ip}:{port}，txt.service='_uscan._tcp.local'。
   */
  async scanUscan(windowMs = SCAN_WINDOW_MS): Promise<DiscoveredIpPrinter[]> {
    if (!this.isAvailable() || !this.socket) {
      this.lastScanNote = this.lastScanNote || 'mDNS 不可用（socket 未绑定）'
      return []
    }
    this.collectBuffer = []
    const query = encodeQuery([{ name: USCAN_SERVICE, type: TYPE_PTR }])
    try {
      this.socket.send(query, MDNS_PORT, MDNS_GROUP)
    } catch (err) {
      this.lastScanNote = `mDNS _uscan 查询发送失败：${err instanceof Error ? err.message : String(err)}`
      this.collectBuffer = null
      return []
    }
    await new Promise((resolve) => setTimeout(resolve, windowMs))
    const packets = this.collectBuffer ?? []
    this.collectBuffer = null
    const scanners = aggregate(packets, 'scanners')
    this.opts.log.record({
      type: 'discovery',
      topic: 'mdns',
      message: `mDNS _uscan 扫描完成：${scanners.length} 台扫描仪（${scanners.map((p) => p.name).join('、') || '无'}）`,
    })
    return scanners
  }

  // ---------------------------------------------------------------- 通告（advertiser）

  private serviceInstances(): ServiceInstance[] {
    const out: ServiceInstance[] = []
    const vipp = this.opts.vipp
    if (vipp) {
      const tlsPort = vipp.tlsActivePort
      for (const snapshot of vipp.list()) {
        const label = snapshot.profile
        const baseTxt = {
          txtvers: '1',
          rp: `printers/${snapshot.id}`,
          ty: 'OpenPrintShare Virtual IPP',
          pdl: 'application/pdf',
          qtotal: '1',
        }
        out.push({
          instanceName: `OPS Virtual IPP ${label}._ipp._tcp.local`,
          ptrName: IPP_SERVICE,
          host: this.hostname,
          port: vipp.port,
          txt: { ...baseTxt, note: 'OPS Virtual IPP Server' },
        })
        if (tlsPort !== null) {
          out.push({
            instanceName: `OPS Virtual IPP ${label}._ipps._tcp.local`,
            ptrName: IPPS_SERVICE,
            host: this.hostname,
            port: tlsPort,
            txt: { ...baseTxt, note: 'OPS Virtual IPP Server (ipps/TLS)' },
          })
        }
      }
    }
    // Virtual eSCL Scanner（P3）：每台档案一个 _uscan._tcp 实例（rp 指向 eSCL 任务端点）
    const vscan = this.opts.vscan
    if (vscan) {
      for (const scanner of vscan.list()) {
        out.push({
          instanceName: `OPS Virtual Scanner ${scanner.label}._uscan._tcp.local`,
          ptrName: USCAN_SERVICE,
          host: this.hostname,
          port: vscan.port,
          txt: {
            txtvers: '1',
            rp: 'eSCL/ScanJobs',
            ty: 'OpenPrintShare Virtual Scanner',
            pdl: 'image/png',
            note: 'OPS Virtual eSCL Scanner',
          },
        })
      }
    }
    return out
  }

  private localIps(): string[] {
    const ips: string[] = []
    for (const list of Object.values(networkInterfaces())) {
      for (const net of list ?? []) {
        if (net.family === 'IPv4' && !net.internal) ips.push(net.address)
      }
    }
    return ips
  }

  /** 周期/立即通告（组播 PTR+SRV+TXT+A） */
  private announce(): void {
    const instances = this.serviceInstances()
    if (instances.length === 0 || !this.socket) return
    const records: DnsRecord[] = []
    for (const inst of instances) {
      records.push({ name: inst.ptrName, type: TYPE_PTR, class: 1, ttl: 4500, rdata: encodeName(inst.instanceName) })
    }
    for (const inst of instances) {
      records.push({ name: inst.instanceName, type: TYPE_SRV, class: 1, ttl: 120, rdata: srvRdata(inst.port, inst.host) })
      records.push({ name: inst.instanceName, type: TYPE_TXT, class: 1, ttl: 120, rdata: txtRdata(inst.txt) })
    }
    for (const ip of this.localIps()) {
      records.push({ name: this.hostname, type: TYPE_A, class: 1, ttl: 120, rdata: Buffer.from(ip.split('.').map(Number)) })
    }
    const packet = encodeResponse(records)
    try {
      this.socket.send(packet, MDNS_PORT, MDNS_GROUP)
    } catch (err) {
      console.warn('[mdns] announce 发送失败:', err)
    }
  }

  // ---------------------------------------------------------------- 入站分发

  private onMessage(buf: Buffer): void {
    let packet: DnsPacket
    try {
      packet = decodeDnsPacket(buf)
    } catch {
      return // 忽略非法包
    }
    if (packet.isResponse) {
      if (this.collectBuffer) this.collectBuffer.push(packet)
      return
    }
    // 查询 → 通告器应答
    this.answerQuery(packet)
  }

  private answerQuery(query: DnsPacket): void {
    const instances = this.serviceInstances()
    if (instances.length === 0 || !this.socket) return
    const records: DnsRecord[] = []
    const localIps = this.localIps()
    for (const q of query.questions) {
      const lower = q.name.toLowerCase()
      if (q.type === TYPE_PTR || q.type === 255) {
        // PTR 查询：_ipp/_ipps/_universal(_sub._ipp)/_pdl-datastream/_uscan
        // 只应答与查询服务类型匹配的实例（_pdl 查询不返回 _ipp/_ipps 实例 —— 否则聚合端 service 标签会被覆盖污染）
        if (
          lower.endsWith('_ipp._tcp.local') ||
          lower.endsWith('_ipps._tcp.local') ||
          lower.endsWith('_pdl-datastream._tcp.local') ||
          lower.endsWith('_uscan._tcp.local')
        ) {
          for (const inst of instances) {
            const instService = inst.ptrName.toLowerCase()
            const matches =
              (lower === instService) || // 同服务（_ipp → _ipp 实例，_ipps → _ipps 实例，_uscan → _uscan 实例）
              (lower.startsWith('_universal._sub._ipp') && instService === IPP_SERVICE) // Universal 子类型 → _ipp 实例
            if (matches) {
              records.push({ name: q.name, type: TYPE_PTR, class: 0x8001, ttl: 4500, rdata: encodeName(inst.instanceName) })
              records.push({ name: inst.instanceName, type: TYPE_SRV, class: 0x8001, ttl: 120, rdata: srvRdata(inst.port, inst.host) })
              records.push({ name: inst.instanceName, type: TYPE_TXT, class: 0x8001, ttl: 120, rdata: txtRdata(inst.txt) })
            }
          }
        }
      } else if (q.type === TYPE_SRV || q.type === TYPE_TXT) {
        for (const inst of instances) {
          if (inst.instanceName.toLowerCase() === lower) {
            records.push({ name: inst.instanceName, type: TYPE_SRV, class: 0x8001, ttl: 120, rdata: srvRdata(inst.port, inst.host) })
            records.push({ name: inst.instanceName, type: TYPE_TXT, class: 0x8001, ttl: 120, rdata: txtRdata(inst.txt) })
          }
        }
      } else if (q.type === TYPE_A) {
        if (lower === this.hostname.toLowerCase()) {
          for (const ip of localIps) {
            records.push({ name: this.hostname, type: TYPE_A, class: 0x8001, ttl: 120, rdata: Buffer.from(ip.split('.').map(Number)) })
          }
        }
      }
    }
    if (records.length === 0) return
    // 附带本机 hostname 的 A 记录（additional section）：客户端聚合时才能解析 SRV target → IP，
    // 否则扫描仪 uri 会回退 127.0.0.1（与本机 vscan baseUrl 撞车被去重过滤）
    for (const ip of localIps) {
      records.push({ name: this.hostname, type: TYPE_A, class: 0x8001, ttl: 120, rdata: Buffer.from(ip.split('.').map(Number)) })
    }
    const packet = encodeResponse(records)
    try {
      this.socket.send(packet, MDNS_PORT, MDNS_GROUP)
    } catch {
      /* 尽力而为 */
    }
  }
}

/**
 * 响应包聚合：PTR→SRV→TXT→A → DiscoveredIpPrinter[]。
 * mode='printers'：仅打印机类服务（_uscan 扫描仪实例不进打印列表）；
 * mode='scanners'：仅 _uscan 扫描仪实例（uri=http://{ip}:{port}，txt.service='_uscan._tcp.local'）。
 */
function aggregate(packets: DnsPacket[], mode: 'printers' | 'scanners' = 'printers'): DiscoveredIpPrinter[] {
  const ptrs = new Map<string, string>() // instanceName → serviceType（PTR 目标）
  const srvs = new Map<string, { port: number; target: string }>()
  const txts = new Map<string, Record<string, string>>()
  const aRecords = new Map<string, string>() // hostname → ip

  for (const packet of packets) {
    for (const record of [...packet.answers, ...packet.additionals]) {
      try {
        if (record.type === TYPE_PTR) {
          const target = parsePtr(record.rdata)
          if (
            target.endsWith('_ipp._tcp.local') ||
            target.endsWith('_ipps._tcp.local') ||
            target.endsWith('_pdl-datastream._tcp.local') ||
            target.endsWith('_uscan._tcp.local') ||
            target.includes('._sub._ipp._tcp.local')
          ) {
            ptrs.set(target, record.name)
          }
        } else if (record.type === TYPE_SRV) {
          const srv = parseSrv(record.rdata)
          srvs.set(record.name, srv)
        } else if (record.type === TYPE_TXT) {
          txts.set(record.name, parseTxt(record.rdata))
        } else if (record.type === TYPE_A) {
          if (record.rdata.length === 4) {
            aRecords.set(record.name, `${record.rdata[0]}.${record.rdata[1]}.${record.rdata[2]}.${record.rdata[3]}`)
          }
        }
      } catch {
        /* 单条记录解析失败不影响其它 */
      }
    }
  }

  const out: DiscoveredIpPrinter[] = []
  const seen = new Set<string>()
  for (const [instanceName, ptrRecordName] of ptrs) {
    const lowerInstance = instanceName.toLowerCase()
    const isUscan = lowerInstance.endsWith(USCAN_SERVICE)
    // 扫描仪不属于打印列表：printers 模式跳过 _uscan；scanners 模式只保留 _uscan
    if (mode === 'printers' && isUscan) continue
    if (mode === 'scanners' && !isUscan) continue
    const srv = srvs.get(instanceName)
    if (!srv) continue
    const txt = txts.get(instanceName) ?? {}
    const ip = aRecords.get(srv.target) ?? '127.0.0.1'
    // 实例名首标签 = 展示名
    const display = instanceName.split('.')[0] ?? instanceName
    const rp = txt['rp'] && txt['rp'] !== '' ? txt['rp'].replace(/^\/+/, '') : 'ipp/print'
    // 服务类型按实例名确定性推导（PTR record.name 会因多服务查询响应被覆盖，不能作为判定依据）
    const derivedService = isUscan
      ? USCAN_SERVICE
      : lowerInstance.endsWith('_ipps._tcp.local')
        ? '_ipps._tcp.local'
        : lowerInstance.endsWith('_pdl-datastream._tcp.local')
          ? '_pdl-datastream._tcp.local'
          : lowerInstance.includes('._sub._ipp._tcp.local')
            ? '_universal._sub._ipp._tcp.local'
            : lowerInstance.endsWith('_ipp._tcp.local')
              ? '_ipp._tcp.local'
              : ptrRecordName
    // 扫描仪 uri 只到 origin（eSCL 端点由 rp=eSCL/ScanJobs 推导）；打印机按 scheme 拼 rp
    const uri = isUscan ? `http://${ip}:${srv.port}` : `${lowerInstance.endsWith('_ipps._tcp.local') ? 'ipps' : 'ipp'}://${ip}:${srv.port}/${rp}`
    // 去重键：扫描仪同 IP 同端口承载多个档案（uri 相同），须按实例名去重；打印机按 URI
    const seenKey = isUscan ? instanceName : uri
    if (seen.has(seenKey)) continue
    seen.add(seenKey)
    out.push({
      name: display,
      host: srv.target,
      ip,
      port: srv.port,
      uri,
      txt: { ...txt, service: derivedService },
      source: 'mdns',
    })
  }
  return out
}
