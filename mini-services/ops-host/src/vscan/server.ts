import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { deflateSync } from 'node:zlib'

/**
 * Virtual eSCL Scanner — 自建 eSCL 服务端（端口 3065，Apple AirScan 扫描协议）。
 *
 * 目的：在无实体扫描仪的沙箱中，让「真实 eSCL HTTP+XML 协议链路」可以端到端验证：
 *   ScanManager → EsclClient（ScanSettings XML 编码）→ HTTP POST application/xml
 *     → 本服务（解析 → 生成 PNG 页面流）→ NextDocument 逐页取图 → Cancel。
 *
 * 实现的 eSCL 端点（与 sane-airscan 客户端行为对齐）：
 *   - GET    /eSCL/ScannerStatus            扫描仪状态 XML（<scan:State>）
 *   - POST   /eSCL/ScanJobs                 创建扫描任务（201 + Location: /eSCL/ScanJobs/{uuid}）
 *   - GET    /eSCL/ScanJobs/{uuid}/NextDocument  逐页取图（200 PNG / 404 取完 / 409 未就绪）
 *   - DELETE /eSCL/ScanJobs/{uuid}          取消任务（200，幂等）
 *
 * 内置 2 个档案（mDNS 以 _uscan._tcp 通告）：
 *   - vscan-flatbed：OPS Virtual Scanner Flatbed（Platen，1 页）
 *   - vscan-adf    ：OPS Virtual Scanner ADF（Platen 1 页 / Feeder 2 页）
 *
 * PNG 页面纯手写生成（node:zlib deflateSync + 手写 CRC32 查表法，零外部依赖），
 * 每页内容：白底 + 顶部渐变色带（页 1 红黄 / 页 2 蓝绿）+ 中部文字行条纹 +
 * 左上角对齐块 + 右下角页码方块 —— 便于肉眼与自动校验区分页序。
 */

/** 扫描就绪延迟（模拟扫描耗时；readyAt 之前的 NextDocument 返回 409） */
const SCAN_READY_DELAY_MS = 1800

// ---------------------------------------------------------------- PNG 手写编码（零依赖）

/** CRC32 标准查表法（多项式 0xEDB88320，PNG 规范） */
const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c >>> 0
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

/** PNG chunk：length(4) + type(4) + data + crc32(type+data)(4) */
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

/** dpi → 页面像素尺寸（Letter 比例；600 以上钳制，避免超大图像） */
function pageDims(dpi: number): { w: number; h: number } {
  if (dpi <= 150) return { w: 425, h: 550 }
  if (dpi <= 300) return { w: 850, h: 1100 }
  return { w: 1700, h: 2200 } // 600dpi 档 / 更高 dpi 一律钳制（clamp 2000 内外近似档）
}

/**
 * 渲染一页模拟扫描件 PNG（8bit，RGB colorType=2 / Gray colorType=0，非隔行）。
 * 内容：白底 + 顶部 120px 渐变色带（页 1 红黄 / 页 2 蓝绿，Grayscale 转 0.299r+0.587g+0.114b）
 *       + 中部每 28px 一组 3px 深灰"文字行"条纹 + 左上角 (30,30) 80×80 黑色对齐块
 *       + 右下角 pageIndex 个 20×20 黑方块（页码）。
 */
export function renderScanPagePng(opts: { pageIndex: number; colorMode: 'RGB' | 'Grayscale'; dpi: number }): Buffer {
  const { pageIndex, colorMode, dpi } = opts
  const { w, h } = pageDims(dpi)
  const gray = colorMode === 'Grayscale'
  const bpp = gray ? 1 : 3 // bytes per pixel
  const stride = 1 + w * bpp // 每行 = filter 字节(0) + 像素数据
  const raw = Buffer.alloc(stride * h)

  /** 写单像素（越界忽略；Grayscale 按亮度加权换算） */
  const put = (x: number, y: number, r: number, g: number, b: number): void => {
    if (x < 0 || x >= w || y < 0 || y >= h) return
    const off = y * stride + 1 + x * bpp
    if (gray) {
      raw[off] = Math.round(0.299 * r + 0.587 * g + 0.114 * b)
    } else {
      raw[off] = r
      raw[off + 1] = g
      raw[off + 2] = b
    }
  }
  const fill = (x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number): void => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) put(x, y, r, g, b)
  }

  // 白底
  fill(0, 0, w, h, 255, 255, 255)

  // 顶部 120px 渐变色带：页 1 红→黄 / 页 2 蓝→绿（横向渐变）
  const bandH = Math.min(120, h - 1)
  const redYellow = pageIndex % 2 === 1
  for (let y = 0; y < bandH; y++) {
    for (let x = 0; x < w; x++) {
      const t = w > 1 ? x / (w - 1) : 0
      if (redYellow) {
        put(x, y, 255, Math.round(255 * t), 0) // 红(255,0,0) → 黄(255,255,0)
      } else {
        put(x, y, 0, Math.round(255 * t), Math.round(255 * (1 - t))) // 蓝(0,0,255) → 绿(0,255,0)
      }
    }
  }

  // 中部"文字行"条纹：每 28px 一组 3px 深灰横条（模拟文档正文）
  const stripeX0 = Math.round(w * 0.1)
  const stripeX1 = Math.round(w * 0.9)
  const stripeY0 = Math.round(h * 0.2)
  const stripeY1 = h - 160
  for (let y = stripeY0; y + 3 <= stripeY1; y += 28) {
    fill(stripeX0, y, stripeX1, y + 3, 70, 70, 70)
  }

  // 左上角 (30,30) 起 80×80 黑色对齐块
  fill(30, 30, 30 + 80, 30 + 80, 0, 0, 0)

  // 右下角 pageIndex 个 20×20 黑方块（页码，从右向左排列）
  for (let i = 0; i < pageIndex; i++) {
    const bx = w - 30 - 20 - i * (20 + 8)
    const by = h - 30 - 20
    fill(bx, by, bx + 20, by + 20, 0, 0, 0)
  }

  // 组装 PNG：签名 + IHDR + IDAT(每行前置 filter 0) + IEND
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = gray ? 0 : 2 // color type：0=灰度 / 2=RGB
  ihdr[10] = 0 // compression method（deflate）
  ihdr[11] = 0 // filter method
  ihdr[12] = 0 // interlace method（非隔行）
  const compressed = deflateSync(raw, { level: 6 })
  return Buffer.concat([signature, pngChunk('IHDR', ihdr), pngChunk('IDAT', compressed), pngChunk('IEND', Buffer.alloc(0))])
}

// ---------------------------------------------------------------- 服务端

/** 扫描仪档案 */
interface VscanProfile {
  id: string
  name: string
  label: string
}

const PROFILES: VscanProfile[] = [
  { id: 'vscan-flatbed', name: 'OPS Virtual Scanner Flatbed', label: 'Flatbed' },
  { id: 'vscan-adf', name: 'OPS Virtual Scanner ADF', label: 'ADF' },
]

/** 内存中的扫描任务（不落盘 —— vscan 是纯虚拟设备，重启即清空） */
interface VscanJob {
  uuid: string
  createdAt: number
  source: 'Platen' | 'Feeder'
  format: string
  dpi: number
  colorMode: 'RGB' | 'Grayscale'
  pagesTotal: number
  pagesTaken: number
  readyAt: number
  canceled: boolean
}

export interface VscanServerOptions {
  port: number
  /** 数据目录（对齐 vipp 习惯预留；vscan 任务纯内存，仅确保目录存在便于排查日志） */
  dataDir?: string
}

export interface VscanDeviceInfo {
  id: string
  name: string
  label: string
  baseUrl: string
}

export class VirtualScanServer {
  private server: Server | null = null
  private readonly jobs = new Map<string, VscanJob>()
  readonly port: number
  readonly dataDir: string

  constructor(private readonly opts: VscanServerOptions) {
    this.port = opts.port
    this.dataDir = opts.dataDir ?? ''
  }

  async start(): Promise<void> {
    if (this.dataDir) {
      await fs.mkdir(this.dataDir, { recursive: true }).catch(() => {})
    }
    await new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.handle(req, res).catch((err) => {
          console.error('[vscan] request handler error:', err)
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
    // 启动自检：生成一页 PNG，校验魔数与 IHDR 宽高（编码器零依赖，必须自己兜底）
    const probe = renderScanPagePng({ pageIndex: 1, colorMode: 'RGB', dpi: 300 })
    const magicOk =
      probe[0] === 0x89 && probe[1] === 0x50 && probe[2] === 0x4e && probe[3] === 0x47 && probe[4] === 0x0d && probe[5] === 0x0a && probe[6] === 0x1a && probe[7] === 0x0a
    const ihdrW = probe.readUInt32BE(16)
    const ihdrH = probe.readUInt32BE(20)
    if (!magicOk || ihdrW !== 850 || ihdrH !== 1100) {
      throw new Error(`[vscan] PNG 自检失败：magic=${magicOk}，IHDR=${ihdrW}x${ihdrH}（期望 850x1100）`)
    }
    console.log(`[vscan] PNG 自检通过: 850x1100, ${probe.length} bytes`)
    console.log(`[vscan] Virtual eSCL Scanner listening on :${this.port}（${PROFILES.length} 台虚拟扫描仪：${PROFILES.map((p) => p.id).join('、')}）`)
  }

  dispose(): void {
    this.server?.close()
    this.server = null
    this.jobs.clear()
  }

  /** 供 mDNS 通告 / ScanManager 设备列表使用 */
  list(): VscanDeviceInfo[] {
    return PROFILES.map((p) => ({ ...p, baseUrl: `http://127.0.0.1:${this.port}` }))
  }

  /** 当前是否有未完成任务（ScannerStatus 用：Idle / Processing） */
  private hasActiveJob(): boolean {
    for (const job of this.jobs.values()) {
      if (!job.canceled && job.pagesTaken < job.pagesTotal) return true
    }
    return false
  }

  private sendXml(res: ServerResponse, code: number, xml: string): void {
    res.writeHead(code, { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'no-store' })
    res.end(xml)
  }

  private sendJson(res: ServerResponse, code: number, data: unknown): void {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(data))
  }

  private async readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('error', reject)
    })
  }

  // ---------------------------------------------------------------- eSCL 路由

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const method = req.method ?? 'GET'
    const path = url.pathname.replace(/\/+$/, '') || '/'

    // 健康检查（对齐 vipp 的 /healthz 习惯）
    if (method === 'GET' && (path === '/' || path === '/healthz')) {
      this.sendJson(res, 200, { service: 'ops-virtual-escl-scanner', port: this.port, jobs: this.jobs.size, active: this.hasActiveJob() })
      return
    }

    // GET /eSCL/ScannerStatus —— 状态 XML（<scan:State>Idle|Processing）
    if (method === 'GET' && path === '/eSCL/ScannerStatus') {
      const state = this.hasActiveJob() ? 'Processing' : 'Idle'
      const xml =
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<scan:ScannerStatus xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03">\n' +
        '  <scan:Version>2.1</scan:Version>\n' +
        `  <scan:State>${state}</scan:State>\n` +
        '</scan:ScannerStatus>\n'
      this.sendXml(res, 200, xml)
      return
    }

    // POST /eSCL/ScanJobs —— 创建扫描任务
    if (method === 'POST' && path === '/eSCL/ScanJobs') {
      const body = (await this.readBody(req)).toString('utf8')
      const pick = (tag: string): string | null => {
        const m = new RegExp(`<[^>]*${tag}[^>]*>\\s*([^<]*?)\\s*</[^>]*${tag}>`, 'i').exec(body)
        return m ? m[1]! : null
      }
      const inputSource = pick('InputSource') === 'Feeder' ? 'Feeder' : 'Platen'
      const format = pick('DocumentFormat') ?? 'image/png'
      const dpi = Number(pick('XResolution') ?? 300) || 300
      const colorMode = pick('ColorMode') === 'Grayscale' ? 'Grayscale' : 'RGB'
      const uuid = randomUUID()
      const pagesTotal = inputSource === 'Feeder' ? 2 : 1 // ADF 档案送纸器 2 页；平板 1 页
      this.jobs.set(uuid, {
        uuid,
        createdAt: Date.now(),
        source: inputSource,
        format,
        dpi,
        colorMode,
        pagesTotal,
        pagesTaken: 0,
        readyAt: Date.now() + SCAN_READY_DELAY_MS,
        canceled: false,
      })
      console.log(`[vscan] job 创建：${uuid}（source=${inputSource}，format=${format}，dpi=${dpi}，colorMode=${colorMode}，pages=${pagesTotal}）`)
      res.writeHead(201, { location: `/eSCL/ScanJobs/${uuid}`, 'content-type': 'application/xml; charset=utf-8' })
      res.end()
      return
    }

    // /eSCL/ScanJobs/{uuid}[/NextDocument]
    const m = /^\/eSCL\/ScanJobs\/([0-9a-fA-F-]{8,64})(\/NextDocument)?$/.exec(path)
    if (m) {
      const uuid = m[1]!
      const isNext = m[2] !== undefined
      const job = this.jobs.get(uuid)

      // DELETE /eSCL/ScanJobs/{uuid} —— 取消（幂等：不存在也 200）
      if (method === 'DELETE' && !isNext) {
        if (job) {
          job.canceled = true
          console.log(`[vscan] job 取消：${uuid}（已取 ${job.pagesTaken}/${job.pagesTotal} 页）`)
        }
        this.sendJson(res, 200, { ok: true })
        return
      }

      // GET /eSCL/ScanJobs/{uuid}/NextDocument —— 逐页取图
      if (method === 'GET' && isNext) {
        if (!job || job.canceled) {
          this.sendJson(res, 404, { error: `扫描任务不存在或已取消：${uuid}` })
          return
        }
        if (job.pagesTaken >= job.pagesTotal) {
          console.log(`[vscan] job 取页结束（404）：${uuid}（${job.pagesTaken}/${job.pagesTotal}）`)
          this.sendJson(res, 404, { error: '没有更多页面（已全部取出）' })
          return
        }
        if (Date.now() < job.readyAt) {
          this.sendJson(res, 409, { error: '页面尚未就绪（扫描中）' })
          return
        }
        const pageIndex = job.pagesTaken + 1
        const png = renderScanPagePng({ pageIndex, colorMode: job.colorMode, dpi: job.dpi })
        job.pagesTaken++
        console.log(`[vscan] job 取页：${uuid} 第 ${pageIndex}/${job.pagesTotal} 页（${png.length} bytes，${job.colorMode}，${job.dpi}dpi）`)
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(png.length), 'cache-control': 'no-store' })
        res.end(png)
        return
      }
    }

    this.sendJson(res, 404, { error: `未知 eSCL 端点：${method} ${path}` })
  }
}

/** 供外部（自测脚本等）复用的独立渲染入口 */
export { renderScanPagePng as renderPng, pageDims as vscanPageDims, PROFILES as VSCAN_PROFILES }
