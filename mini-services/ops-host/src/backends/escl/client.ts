import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

/**
 * eSCL 客户端（Apple AirScan 扫描协议，HTTP + XML，与 sane-airscan 行为对齐）。
 *
 * 传输：node:http / node:https（https 自签名容忍 —— 局域网扫描仪几乎全部使用自签证书，
 * 与 IPP TOFU 策略一致：不校验 CA，仅要求通道可用）。
 *
 * eSCL 端点约定（Scanner 以 baseUrl 为根，如 http://127.0.0.1:3065）：
 *   - GET    {base}/eSCL/ScannerStatus      扫描仪状态 XML（<scan:State>Idle|Processing|...）
 *   - POST   {base}/eSCL/ScanJobs           创建扫描任务（ScanSettings XML）→ 201 + Location
 *   - GET    {jobUrl}/NextDocument          逐页取图像（200 / 404 取完 / 409 未就绪）
 *   - DELETE {jobUrl}                       取消扫描任务
 *
 * XML 采用正则轻量解析（eSCL 报文结构稳定且无嵌套需求，无需完整 XML 解析器）。
 */

/** 扫描请求参数（ScanSettings XML 的结构化形态） */
export interface EsclScanRequest {
  format: 'image/png' | 'application/pdf'
  dpi: number
  colorMode: 'RGB' | 'Grayscale'
  inputSource: 'Platen' | 'Feeder'
  /** 双面扫描（eSCL <scan:Duplex>true；仅 Feeder 语义有效，调用方校验） */
  duplex?: boolean
}

/** eSCL HTTP 层错误（含状态码，供调用方区分 404 取完 / 409 未就绪等语义） */
export class EsclHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export class EsclTransportError extends Error {
  constructor(url: string, cause: unknown) {
    super(`eSCL 传输失败（${url}）：${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

export interface EsclResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  data: Buffer
}

/**
 * 通用 eSCL 请求：POST / GET / DELETE 封装（照抄 ipp/client.ts 的 httpPost 模式）。
 * https 不校验证书（rejectUnauthorized: false）。
 */
export function esclRequest(
  url: string,
  method: 'GET' | 'POST' | 'DELETE',
  body?: Buffer,
  headers: Record<string, string> = {},
  timeoutMs = 8000,
): Promise<EsclResponse> {
  return new Promise((resolve, reject) => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch (err) {
      reject(err)
      return
    }
    const send = parsed.protocol === 'https:' ? httpsRequest : httpRequest
    const req = send(
      parsed,
      {
        method,
        headers,
        // 自签名容忍（局域网扫描仪普遍自签，与 sane-airscan / CUPS driverless 行为一致）
        ...(parsed.protocol === 'https:' ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, data: Buffer.concat(chunks) }))
        res.on('error', reject)
      },
    )
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`HTTP 请求超时（${timeoutMs}ms）`)))
    req.on('error', reject)
    req.end(body)
  })
}

/** 构造 ScanSettings XML（Content-Type: application/xml） */
export function buildScanSettingsXml(req: EsclScanRequest): Buffer {
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<scan:ScanSettings xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03">\n' +
    '  <scan:Version>2.1</scan:Version>\n' +
    '  <scan:Intent>Document</scan:Intent>\n' +
    '  <scan:ScanRegions><scan:ScanRegion>\n' +
    '    <scan:Height>3507</scan:Height><scan:Width>2480</scan:Width>\n' +
    '    <scan:XOffset>0</scan:XOffset><scan:YOffset>0</scan:YOffset>\n' +
    '    <scan:ContentRegionUnits>escl:ThreeHundredthsOfInches</scan:ContentRegionUnits>\n' +
    '  </scan:ScanRegion></scan:ScanRegions>\n' +
    `  <scan:InputSource>${req.inputSource}</scan:InputSource>\n` +
    (req.duplex ? '  <scan:Duplex>true</scan:Duplex>\n' : '') +
    `  <scan:DocumentFormat>${req.format}</scan:DocumentFormat>\n` +
    `  <scan:XResolution>${req.dpi}</scan:XResolution>\n` +
    `  <scan:YResolution>${req.dpi}</scan:YResolution>\n` +
    `  <scan:ColorMode>${req.colorMode}</scan:ColorMode>\n` +
    '</scan:ScanSettings>\n'
  return Buffer.from(xml, 'utf8')
}

/** XML 正则轻量提取：<prefix:Tag>value</prefix:Tag>（命名空间前缀无关） */
export function xmlTag(xml: string, tag: string): string | null {
  const m = new RegExp(`<[^>]*${tag}[^>]*>\\s*([^<]*?)\\s*</[^>]*${tag}>`, 'i').exec(xml)
  return m ? m[1]! : null
}

/** 相对 Location → 绝对 jobUrl（拼 baseUrl origin） */
function resolveJobUrl(baseUrl: string, location: string): string {
  try {
    return new URL(location, baseUrl).toString()
  } catch {
    return location
  }
}

/** jobUrl 兼容绝对 / 相对两种形态 → 绝对 URL */
function absoluteUrl(baseUrl: string, jobUrl: string): string {
  if (/^https?:\/\//i.test(jobUrl)) return jobUrl
  try {
    return new URL(jobUrl, baseUrl).toString()
  } catch {
    return jobUrl
  }
}

export interface EsclClientOptions {
  timeoutMs?: number
}

export class EsclClient {
  private readonly timeoutMs: number

  constructor(opts: EsclClientOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 8000
  }

  /** GET {base}/eSCL/ScannerStatus — 正则取 <scan:State> */
  async getScannerStatus(baseUrl: string): Promise<{ state: string; raw: string }> {
    let res: EsclResponse
    try {
      res = await esclRequest(`${baseUrl.replace(/\/+$/, '')}/eSCL/ScannerStatus`, 'GET', undefined, { accept: 'application/xml' }, this.timeoutMs)
    } catch (err) {
      throw new EsclTransportError(`${baseUrl}/eSCL/ScannerStatus`, err)
    }
    if (res.status < 200 || res.status >= 300) {
      throw new EsclHttpError(res.status, `ScannerStatus HTTP ${res.status}`)
    }
    const raw = res.data.toString('utf8')
    return { state: xmlTag(raw, 'State') ?? 'Unknown', raw }
  }

  /**
   * GET {base}/eSCL/ScannerCapabilities — 双面能力探测。
   * 能力三态：①端点 200 且含 <scan:Duplex>true → 'yes' ②200 且显式非 true → 'no'
   * ③端点 404/405 / 无 Duplex 元素 / 传输错误 / 非 2xx → 'unknown'（探测失败≠设备不支持，不抛错）
   */
  async getScannerCapabilities(baseUrl: string): Promise<{ duplex: 'yes' | 'no' | 'unknown'; raw: string }> {
    const base = baseUrl.replace(/\/+$/, '')
    let res: EsclResponse
    try {
      res = await esclRequest(`${base}/eSCL/ScannerCapabilities`, 'GET', undefined, { accept: 'application/xml' }, this.timeoutMs)
    } catch {
      return { duplex: 'unknown', raw: '' }
    }
    if (res.status < 200 || res.status >= 300) return { duplex: 'unknown', raw: '' }
    const raw = res.data.toString('utf8')
    const duplexRaw = xmlTag(raw, 'Duplex')
    if (duplexRaw === null) return { duplex: 'unknown', raw }
    return { duplex: /^true$/i.test(duplexRaw.trim()) ? 'yes' : 'no', raw }
  }

  /** POST {base}/eSCL/ScanJobs — body=ScanSettings XML，201 后取 Location 头（相对路径拼 baseUrl origin） */
  async createScanJob(baseUrl: string, req: EsclScanRequest): Promise<{ jobUrl: string }> {
    const base = baseUrl.replace(/\/+$/, '')
    let res: EsclResponse
    try {
      res = await esclRequest(
        `${base}/eSCL/ScanJobs`,
        'POST',
        buildScanSettingsXml(req),
        { 'content-type': 'application/xml', accept: 'application/xml' },
        this.timeoutMs,
      )
    } catch (err) {
      throw new EsclTransportError(`${base}/eSCL/ScanJobs`, err)
    }
    if (res.status !== 201 && res.status !== 200) {
      throw new EsclHttpError(res.status, `创建扫描任务失败：HTTP ${res.status}`)
    }
    const location = res.headers['location']
    const locationStr = Array.isArray(location) ? (location[0] ?? '') : (location ?? '')
    if (!locationStr) {
      throw new EsclHttpError(res.status, '创建扫描任务成功但响应缺少 Location 头（job URL）')
    }
    const jobUrl = resolveJobUrl(base, locationStr)
    return { jobUrl }
  }

  /**
   * GET {jobUrl}/NextDocument — 200 返回图像字节；
   * 404（已取完/不存在）与 409（未就绪）抛 EsclHttpError，由调用方按语义处理。
   */
  async getNextDocument(baseUrl: string, jobUrl: string): Promise<{ data: Uint8Array; contentType: string }> {
    const url = `${absoluteUrl(baseUrl, jobUrl).replace(/\/+$/, '')}/NextDocument`
    let res: EsclResponse
    try {
      res = await esclRequest(url, 'GET', undefined, { accept: 'image/png, application/pdf, */*' }, this.timeoutMs)
    } catch (err) {
      throw new EsclTransportError(url, err)
    }
    if (res.status === 404 || res.status === 409) {
      throw new EsclHttpError(res.status, `NextDocument HTTP ${res.status}（${res.status === 404 ? '已取完或任务不存在' : '页面未就绪'}）`)
    }
    if (res.status < 200 || res.status >= 300) {
      throw new EsclHttpError(res.status, `NextDocument HTTP ${res.status}`)
    }
    const ct = res.headers['content-type']
    const contentType = (Array.isArray(ct) ? (ct[0] ?? '') : (ct ?? '')) || 'application/octet-stream'
    return { data: new Uint8Array(res.data), contentType }
  }

  /** DELETE {jobUrl} — 取消扫描任务（幂等：404 也视为成功） */
  async cancelScanJob(baseUrl: string, jobUrl: string): Promise<void> {
    const url = absoluteUrl(baseUrl, jobUrl)
    let res: EsclResponse
    try {
      res = await esclRequest(url, 'DELETE', undefined, {}, this.timeoutMs)
    } catch (err) {
      throw new EsclTransportError(url, err)
    }
    if (res.status === 404) return // 任务已不存在 —— 幂等取消成功
    if (res.status < 200 || res.status >= 300) {
      throw new EsclHttpError(res.status, `取消扫描任务失败：HTTP ${res.status}`)
    }
  }
}
