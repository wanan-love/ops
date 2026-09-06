import { createServer, type Server, type Socket } from 'node:net'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

/**
 * Virtual PJL Printer — RAW TCP 9100 仿真服务（端口 3067，HP JetDirect / AppSocket 血统）。
 *
 * 目的：在无实体打印机的沙箱中，验证「P4 Vendor Adapter：PJL over 9100 双向状态回读」全链路：
 *   pjl client（node:net 连接 → UEL 包裹的 @PJL INFO 查询）→ 本服务（解析 → 回读响应）→ mergeReports。
 *
 * 连接模型（对齐真实 9100 端口行为）：
 *   - 单连接双向字节流：客户端连上后可发送任意数据（UEL 之间的 PJL 命令 / 打印数据）
 *   - UEL（\x1b%-12345X）分隔命令序列；@PJL 命令为行协议（\r\n 结束）
 *   - 查询响应：UEL + 响应行（key="value"）+ UEL + \r\n（真实设备响应常带 UEL 框，客户端宽容解析）
 *
 * 支持的 @PJL 命令（未列出的静默忽略——真实设备普遍如此）：
 *   - @PJL INFO STATUS   → CODE / DISPLAY / ONLINE（状态码子集见 STATUS_CODES）
 *   - @PJL INFO SUPPLY   → SUPPLY / TYPE / LEVEL / PARTNO（Brother 风格试点格式）
 *   - @PJL INFO CONFIG   → MODEL / MEMORY / DUPLEX
 *   - @PJL INFO PAGECOUNT → PAGECOUNT
 *   - @PJL ECHO <args>   → 回显一行（连通性测试）
 *   - @PJL RESET / @PJL USTATUS OFF → 无副作用确认（日志）
 *
 * 打印数据（UEL 之间非 @PJL 开头的字节）：累计字节数记入 rawReceivedBytes 并按页计数
 *   ——真实 9100 通道收数据即打印（fire-and-forget），本服务如实累计，不做作业语义。
 *
 * 状态机（POST /api/vpjl/condition 注入，对齐 vipp.setCondition 的调试用途）：
 *   ready（默认 10001 / 碳粉 62%）/ busy / warmup / offline / paper-out / paper-jam /
 *   door-open / toner-low（40036 + 碳粉 8%）/ toner-empty（40037 + 碳粉 0%）
 */

/** UEL（Universal Exit Language）：ESC % - 1 2 3 4 5 X */
const UEL = '\x1b%-12345X'

/** PJL 设备状态码（HP PJL 参考手册子集 + 本虚拟设备自定义注入码；映射表见 backends/pjl.ts） */
const STATUS_CODES: Record<VpjlCondition, { code: string; display: string; online: string }> = {
  ready: { code: '10001', display: 'READY', online: 'TRUE' },
  busy: { code: '10004', display: 'PRINTING', online: 'TRUE' },
  warmup: { code: '10003', display: 'WARMING UP', online: 'TRUE' },
  offline: { code: '10002', display: 'OFFLINE', online: 'FALSE' },
  'paper-out': { code: '40014', display: 'PAPER OUT', online: 'TRUE' },
  'paper-jam': { code: '40019', display: 'PAPER JAM', online: 'TRUE' },
  'door-open': { code: '40017', display: 'DOOR OPEN', online: 'TRUE' },
  'toner-low': { code: '40036', display: 'TONER LOW', online: 'TRUE' },
  'toner-empty': { code: '40037', display: 'TONER EMPTY', online: 'TRUE' },
}

/** 状态 → 碳粉余量（toner-low/toner-empty 覆盖默认 62%）
 *  注意：仅 toner 系 SUPPLY 受状态影响，演示「状态探测 + 耗材探测同通道」的联动。 */
const TONER_LEVEL: Partial<Record<VpjlCondition, number>> = {
  'toner-low': 8,
  'toner-empty': 0,
}

export type VpjlCondition = 'ready' | 'busy' | 'warmup' | 'offline' | 'paper-out' | 'paper-jam' | 'door-open' | 'toner-low' | 'toner-empty'

export const VPJL_CONDITIONS: VpjlCondition[] = Object.keys(STATUS_CODES) as VpjlCondition[]

export interface VpjlState {
  condition: VpjlCondition
  /** 累计接收的 RAW 打印字节数（UEL 之间的非 PJL 数据） */
  rawReceivedBytes: number
  /** 模拟已打印页数（每 5120 bytes 计 1 页，仅用于 PAGECOUNT 回读演示） */
  rawPageCount: number
  /** 服务的连接总数（含已关闭） */
  connectionCount: number
  updatedAt: string
}

export interface VpjlServerOptions {
  port: number
  dataDir?: string
}

export class VirtualPjlServer {
  private server: Server | null = null
  private condition: VpjlCondition = 'ready'
  private rawReceivedBytes = 0
  private rawPageCount = 0
  private connectionCount = 0
  readonly port: number
  readonly dataDir: string

  constructor(private readonly opts: VpjlServerOptions) {
    this.port = opts.port
    this.dataDir = opts.dataDir ?? ''
  }

  async start(): Promise<void> {
    if (this.dataDir) {
      await fs.mkdir(this.dataDir, { recursive: true }).catch(() => {})
      await this.loadState().catch(() => {})
    }
    await new Promise<void>((resolve, reject) => {
      const server = createServer((socket) => this.handleConnection(socket))
      server.on('error', reject)
      server.listen(this.port, () => resolve())
      this.server = server
    })
    console.log(`[vpjl] Virtual PJL Printer (RAW 9100) listening on :${this.port} (condition=${this.condition}, toner=${this.tonerLevel()}%)`)
  }

  stop(): void {
    this.server?.close()
    this.server = null
  }

  /** 当前快照（REST /api/vpjl/state） */
  state(): VpjlState {
    return {
      condition: this.condition,
      rawReceivedBytes: this.rawReceivedBytes,
      rawPageCount: this.rawPageCount,
      connectionCount: this.connectionCount,
      updatedAt: new Date().toISOString(),
    }
  }

  /** 注入调试状态（REST /api/vpjl/condition；未知值返回 null） */
  setCondition(condition: string): VpjlState | null {
    if (!VPJL_CONDITIONS.includes(condition as VpjlCondition)) return null
    this.condition = condition as VpjlCondition
    const next = this.state()
    void this.persistState().catch(() => {})
    console.log(`[vpjl] condition → ${condition}（CODE=${STATUS_CODES[this.condition].code}）`)
    return next
  }

  /** 当前状态对应的碳粉余量（toner 系状态覆盖默认） */
  private tonerLevel(): number {
    return TONER_LEVEL[this.condition] ?? 62
  }

  // ---------------------------------------------------------------- 连接处理

  private handleConnection(socket: Socket): void {
    this.connectionCount += 1
    let buffer = ''
    socket.setEncoding('latin1')

    socket.on('data', (chunk: string) => {
      buffer += chunk
      // 按 UEL 切段：段内为命令行或原始打印数据
      let idx: number
      while ((idx = buffer.indexOf(UEL)) !== -1) {
        const before = buffer.slice(0, idx)
        this.consumeSegment(socket, before)
        buffer = buffer.slice(idx + UEL.length)
      }
      // 残余无 UEL 的尾部：可能是纯打印数据（真实 9100 常见：PDF 直灌不带头尾）→ 累计字节；
      // 纯空白（UEL 后的协议性 CRLF 框架字节）不计——协议框架 ≠ 打印数据
      if (buffer.length > 0 && !buffer.startsWith('@PJL') && buffer.trim() !== '') {
        this.countRawBytes(buffer.length)
        buffer = ''
      } else if (buffer.length >= 8192) {
        // 防御：单行 @PJL 命令异常超长（真实协议不会），截断防内存膨胀
        this.countRawBytes(buffer.length)
        buffer = ''
      }
    })

    socket.on('error', (err) => {
      console.warn(`[vpjl] connection error: ${err.message}`)
    })
  }

  /** 处理一个 UEL 之间的段落：@PJL 行命令 → 应答；其它字节 → RAW 打印数据累计 */
  private consumeSegment(socket: Socket, segment: string): void {
    const trimmed = segment.replace(/^[\r\n]+/, '').replace(/[\r\n]+$/, '')
    if (trimmed === '') return
    if (trimmed.startsWith('@PJL')) {
      // 多行命令只处理第一行（INFO/ECHO 单行；数据后续行属于参数场景忽略）
      const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? ''
      this.handlePjlCommand(socket, firstLine)
    } else if (trimmed.length > 0) {
      this.countRawBytes(Buffer.byteLength(segment, 'latin1'))
    }
  }

  private handlePjlCommand(socket: Socket, line: string): void {
    // 形如：@PJL INFO STATUS / @PJL ECHO HELLO / @PJL RESET
    const parts = line.trim().split(/\s+/)
    const cmd = (parts[1] ?? '').toUpperCase()
    const arg = parts.slice(2).join(' ')

    if (cmd === 'INFO') {
      const info = (arg ?? '').toUpperCase()
      if (info === 'STATUS') return this.writeResponse(socket, this.infoStatus())
      if (info === 'SUPPLY') return this.writeResponse(socket, this.infoSupply())
      if (info === 'CONFIG') return this.writeResponse(socket, this.infoConfig())
      if (info === 'PAGECOUNT') return this.writeResponse(socket, this.infoPagecount())
      // 未知 INFO：静默（真实设备常无响应）
      return
    }
    if (cmd === 'ECHO') {
      return this.writeResponse(socket, `@PJL ECHO ${arg}\r\n`)
    }
    if (cmd === 'RESET' || cmd === 'USTATUS') {
      console.log(`[vpjl] ${cmd}（无副作用确认）`)
      return
    }
    // 其余命令（ENTER LANGUAGE 等）：静默忽略
  }

  /** 响应帧：UEL + 体 + UEL + CRLF */
  private writeResponse(socket: Socket, body: string): void {
    socket.write(`${UEL}${body}${UEL}\r\n`, 'latin1')
  }

  private infoStatus(): string {
    const s = STATUS_CODES[this.condition]
    return [
      '@PJL INFO STATUS',
      `CODE="${s.code}"`,
      `DISPLAY="${s.display}"`,
      `ONLINE="${s.online}"`,
      `TOTALPAGES=${this.rawPageCount}`,
    ].join('\r\n') + '\r\n'
  }

  private infoSupply(): string {
    const level = this.tonerLevel()
    return [
      '@PJL INFO SUPPLY',
      'SUPPLY="BLACK TONER"',
      'TYPE="TONER"',
      `LEVEL="${level}"`,
      'PARTNO="OPS-VPjl-01"',
    ].join('\r\n') + '\r\n'
  }

  private infoConfig(): string {
    return [
      '@PJL INFO CONFIG',
      'MODEL="OPS Virtual PJL Printer"',
      'MEMORY=65536',
      'DUPLEX="YES"',
      'PDL="PDF,PCL,PJL"',
    ].join('\r\n') + '\r\n'
  }

  private infoPagecount(): string {
    return `@PJL INFO PAGECOUNT\r\nPAGECOUNT=${this.rawPageCount}\r\n`
  }

  /** RAW 打印数据累计（真实 9100 收数据即打；本服务只做字节级诚实累计） */
  private countRawBytes(n: number): void {
    if (n <= 0) return
    this.rawReceivedBytes += n
    const pages = Math.floor(this.rawReceivedBytes / 5120)
    if (pages > this.rawPageCount) {
      this.rawPageCount = pages
      void this.persistState().catch(() => {})
    }
  }

  // ---------------------------------------------------------------- 持久化（重启保字节计数与调试状态）

  private stateFile(): string {
    return join(this.dataDir, 'state.json')
  }

  private async loadState(): Promise<void> {
    const raw = await fs.readFile(this.stateFile(), 'utf-8')
    const data = JSON.parse(raw) as Partial<VpjlState>
    if (data.condition && VPJL_CONDITIONS.includes(data.condition as VpjlCondition)) {
      this.condition = data.condition as VpjlCondition
    }
    if (typeof data.rawReceivedBytes === 'number') this.rawReceivedBytes = data.rawReceivedBytes
    if (typeof data.rawPageCount === 'number') this.rawPageCount = data.rawPageCount
  }

  private async persistState(): Promise<void> {
    if (!this.dataDir) return
    const data: VpjlState = this.state()
    await fs.writeFile(this.stateFile(), JSON.stringify(data, null, 2), 'utf-8').catch(() => {})
  }
}
