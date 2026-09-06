import type { PrintOptions } from '../../core/types'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import {
  attr,
  encodeIppMessage,
  decodeIppMessage,
  findAttr,
  attrInt,
  attrStr,
  attrStrs,
  statusName,
  isSuccessCode,
  GROUP_OPERATION,
  GROUP_JOB,
  GROUP_JOB_RESPONSE,
  OP_PRINT_JOB,
  OP_CANCEL_JOB,
  OP_GET_JOB_ATTRIBUTES,
  OP_GET_JOBS,
  OP_GET_PRINTER_ATTRIBUTES,
  OP_VALIDATE_JOB,
} from './protocol'
import type { EncAttr, EncGroup, IppMessage } from './protocol'
import type { IppGroup } from './protocol'

/**
 * IPP 客户端（RFC 8010/8011 over HTTP）。
 *
 * 传输：POST http(s)://host:port/path，content-type: application/ipp。
 *  - ipp:// → http://（端口缺省 631）
 *  - ipps:// → https://（端口缺省 631；自签名容忍 —— 局域网打印机几乎全部使用自签证书，
 *    与 CUPS driverless 生态一致采用 TOFU 策略：不校验 CA，仅要求加密通道）
 *  - http(s):// 原样透传
 */

export class IppUnsupportedSchemeError extends Error {
  constructor(uri: string) {
    super(`IPP URI 方案无效（仅支持 ipp:// ipps:// http:// https://）：${uri}`)
  }
}

export class IppStatusError extends Error {
  constructor(public readonly statusCode: number, public readonly statusMessage: string | null) {
    super(`IPP ${statusName(statusCode)}${statusMessage ? `：${statusMessage}` : ''}`)
  }
}

export class IppTransportError extends Error {
  constructor(uri: string, cause: unknown) {
    super(`IPP 传输失败（${uri}）：${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

export interface IppClientOptions {
  timeoutMs?: number
  /** 请求 request-id 起始值（自增） */
  user?: string
}

/** Get-Job-Attributes 解析结果 */
export interface IppJobSnapshot {
  jobId: number
  /** IPP job-state：3 pending / 4 pending-held / 5 processing / 6 processing-stopped / 7 canceled / 8 aborted / 9 completed */
  state: number
  stateReasons: string[]
  stateMessage: string | null
  impressionsCompleted: number | null
  sheetsCompleted: number | null
  impressionsTotal: number | null
  jobName: string | null
}

let requestIdCounter = Math.floor(Date.now() / 1000) & 0xffff

function nextRequestId(): number {
  requestIdCounter = (requestIdCounter + 1) & 0x7fffffff
  return requestIdCounter
}

/** 原生 HTTP/HTTPS POST（ipps 自签名容忍：https 时 rejectUnauthorized=false，TOFU 策略） */
function httpPost(url: string, body: Buffer, headers: Record<string, string>, timeoutMs: number): Promise<{ status: number; data: Buffer }> {
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
        method: 'POST',
        headers,
        // ipps:// 自签名容忍（局域网打印机普遍自签，与 CUPS driverless 行为一致）
        ...(parsed.protocol === 'https:' ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, data: Buffer.concat(chunks) }))
        res.on('error', reject)
      },
    )
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`HTTP 请求超时（${timeoutMs}ms）`)))
    req.on('error', reject)
    req.end(body)
  })
}

/** ipp:// / ipps:// / http(s):// → HTTP URL（ipps → https；端口缺省补 631） */
export function ippUriToHttpUrl(uri: string): string {
  const convert = (scheme: string, defaultPort: string, rest: string): string => {
    const slash = rest.indexOf('/')
    const hostPart = slash >= 0 ? rest.slice(0, slash) : rest
    const pathPart = slash >= 0 ? rest.slice(slash) : '/'
    const hasPort = /:\d+$/.test(hostPart)
    const host = hasPort ? hostPart : `${hostPart}${defaultPort}`
    return `${scheme}://${host}${pathPart}`
  }
  if (uri.startsWith('ipp://')) return convert('http', ':631', uri.slice('ipp://'.length))
  if (uri.startsWith('ipps://')) return convert('https', ':631', uri.slice('ipps://'.length))
  if (uri.startsWith('http://') || uri.startsWith('https://')) return uri
  throw new IppUnsupportedSchemeError(uri)
}

export class IppClient {
  private readonly timeoutMs: number
  private readonly user: string

  constructor(opts: IppClientOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 5000
    this.user = opts.user ?? 'ops-host'
  }

  /** 发送 IPP 消息并解码响应（状态码 ≥0x0400 抛 IppStatusError） */
  private async request(uri: string, input: { code: number; groups: Parameters<typeof encodeIppMessage>[0]['groups']; data?: Uint8Array }): Promise<IppMessage> {
    const body = encodeIppMessage({ code: input.code, requestId: nextRequestId(), groups: input.groups, data: input.data })
    let response: { status: number; data: Buffer }
    try {
      response = await httpPost(ippUriToHttpUrl(uri), Buffer.from(body), { 'content-type': 'application/ipp' }, this.timeoutMs)
    } catch (err) {
      throw new IppTransportError(uri, err)
    }
    if (response.status < 200 || response.status >= 300) {
      const status = response.status
      throw new IppStatusError(status >= 400 && status < 600 ? (status * 0x100) & 0xffff : 0x0500, `HTTP ${status}`)
    }
    const bytes = new Uint8Array(response.data)
    const msg = decodeIppMessage(bytes)
    if (!isSuccessCode(msg.code)) {
      const message = attrStr(findAttr(msg, 'status-message'))
      throw new IppStatusError(msg.code, message)
    }
    return msg
  }

  private baseOperationGroup(uri: string, extra: EncAttr[] = []): EncGroup {
    const attributes: EncAttr[] = [
      attr.charset('attributes-charset', 'utf-8'),
      attr.naturalLanguage('attributes-natural-language', 'en'),
      attr.uri('printer-uri', uri),
      attr.name('requesting-user-name', this.user),
      ...extra,
    ]
    return { tag: GROUP_OPERATION, attributes }
  }

  // ---------------------------------------------------------------- Get-Printer-Attributes (0x000B)

  async getPrinterAttributes(uri: string, requested?: string[]): Promise<IppMessage> {
    const extra: EncAttr[] = requested && requested.length > 0 ? [attr.keyword('requested-attributes', requested)] : [attr.keyword('requested-attributes', 'all')]
    return this.request(uri, {
      code: OP_GET_PRINTER_ATTRIBUTES,
      groups: [this.baseOperationGroup(uri, extra)],
    })
  }

  // ---------------------------------------------------------------- Print-Job (0x0002)

  async printJob(
    uri: string,
    pdf: Uint8Array,
    jobName: string,
    userName: string,
    options: PrintOptions,
  ): Promise<{ jobId: number | null; jobUri: string | null; state: number; reasons: string[]; message: IppMessage }> {
    const sides = options.duplex === 'long-edge' ? 'two-sided-long-edge' : options.duplex === 'short-edge' ? 'two-sided-short-edge' : 'one-sided'
    const quality = options.quality === 'draft' ? 3 : options.quality === 'high' ? 5 : 4
    const msg = await this.request(uri, {
      code: OP_PRINT_JOB,
      groups: [
        {
          tag: GROUP_OPERATION,
          attributes: [
            attr.charset('attributes-charset', 'utf-8'),
            attr.naturalLanguage('attributes-natural-language', 'en'),
            attr.uri('printer-uri', uri),
            attr.name('requesting-user-name', userName),
            attr.name('job-name', jobName.slice(0, 120)),
            attr.mime('document-format', 'application/pdf'),
          ],
        },
        {
          tag: GROUP_JOB,
          attributes: [
            attr.integer('copies', Math.max(1, Math.floor(options.copies))),
            attr.keyword('sides', sides),
            attr.keyword('media', options.paperSize),
            attr.keyword('print-color-mode', options.colorMode === 'color' ? 'color' : 'monochrome'),
            attr.enum('print-quality', quality),
          ],
        },
      ],
      data: pdf,
    })
    const jobGroup = msg.groups.find((g) => g.tag === GROUP_JOB_RESPONSE || g.tag === GROUP_JOB)
    const jobId = attrInt(jobGroup?.attributes.find((a) => a.name === 'job-id'))
    const jobUri = attrStr(jobGroup?.attributes.find((a) => a.name === 'job-uri'))
    const state = attrInt(jobGroup?.attributes.find((a) => a.name === 'job-state')) ?? 3
    const reasons = attrStrs(jobGroup?.attributes.find((a) => a.name === 'job-state-reasons'))
    return { jobId, jobUri, state, reasons, message: msg }
  }

  // ---------------------------------------------------------------- Get-Job-Attributes (0x0009)

  async getJobAttributes(uri: string, jobId: number): Promise<IppJobSnapshot> {
    const msg = await this.request(uri, {
      code: OP_GET_JOB_ATTRIBUTES,
      groups: [
        this.baseOperationGroup(uri),
        { tag: GROUP_JOB, attributes: [attr.integer('job-id', jobId)] },
      ],
    })
    return parseJobSnapshot(msg, jobId)
  }

  // ---------------------------------------------------------------- Get-Jobs (0x000A)

  async getJobs(uri: string, whichJobs: 'not-completed' | 'completed' | 'all' = 'not-completed'): Promise<IppJobSnapshot[]> {
    const msg = await this.request(uri, {
      code: OP_GET_JOBS,
      groups: [
        this.baseOperationGroup(uri, [
          attr.keyword('which-jobs', whichJobs),
          attr.keyword('requested-attributes', ['job-id', 'job-state', 'job-state-reasons', 'job-impressions-completed', 'job-media-sheets-completed', 'job-impressions', 'job-name']),
        ]),
      ],
    })
    const groups = msg.groups.filter((g) => g.tag === GROUP_JOB_RESPONSE || g.tag === GROUP_JOB)
    return groups.map((g) => parseJobSnapshotFromGroup(g, null))
  }

  // ---------------------------------------------------------------- Cancel-Job (0x0008)

  async cancelJob(uri: string, jobId: number): Promise<boolean> {
    await this.request(uri, {
      code: OP_CANCEL_JOB,
      groups: [
        this.baseOperationGroup(uri),
        { tag: GROUP_JOB, attributes: [attr.integer('job-id', jobId)] },
      ],
    })
    return true
  }

  // ---------------------------------------------------------------- Validate-Job (0x000C)

  async validateJob(uri: string, options: PrintOptions): Promise<boolean> {
    const sides = options.duplex === 'none' ? 'one-sided' : 'two-sided-long-edge'
    await this.request(uri, {
      code: OP_VALIDATE_JOB,
      groups: [
        {
          tag: GROUP_OPERATION,
          attributes: [
            attr.charset('attributes-charset', 'utf-8'),
            attr.naturalLanguage('attributes-natural-language', 'en'),
            attr.uri('printer-uri', uri),
            attr.name('requesting-user-name', this.user),
            attr.mime('document-format', 'application/pdf'),
          ],
        },
        { tag: GROUP_JOB, attributes: [attr.integer('copies', Math.max(1, Math.floor(options.copies))), attr.keyword('sides', sides)] },
      ],
    })
    return true
  }
}

/** 从 Get-Job-Attributes / Get-Jobs 响应解析任务快照 */
export function parseJobSnapshot(msg: IppMessage, expectedJobId: number | null): IppJobSnapshot {
  const group = msg.groups.find((g) => g.tag === GROUP_JOB_RESPONSE || g.tag === GROUP_JOB)
  return parseJobSnapshotFromGroup(group, expectedJobId)
}

function parseJobSnapshotFromGroup(group: IppGroup | undefined, expectedJobId: number | null): IppJobSnapshot {
  const find = (name: string) => group?.attributes.find((a) => a.name === name)
  const jobId = attrInt(find('job-id')) ?? expectedJobId ?? -1
  return {
    jobId,
    state: attrInt(find('job-state')) ?? 0,
    stateReasons: attrStrs(find('job-state-reasons')),
    stateMessage: attrStr(find('job-state-message')),
    impressionsCompleted: attrInt(find('job-impressions-completed')),
    sheetsCompleted: attrInt(find('job-media-sheets-completed')),
    impressionsTotal: attrInt(find('job-impressions')),
    jobName: attrStr(find('job-name')),
  }
}
