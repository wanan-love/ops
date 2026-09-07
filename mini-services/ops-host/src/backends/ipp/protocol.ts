/**
 * IPP 二进制协议编解码（RFC 8010 / RFC 8011，纯 TypeScript 自研实现，无第三方依赖）。
 *
 * 消息结构：
 *   version-number(2B) | operation-id/status-code(2B) | request-id(4B)
 *   attribute-group* | end-of-attributes-tag(0x03) | data(如 PDF 文档)
 *
 * 属性组：
 *   0x01 operation-attrs / 0x02 job-attrs / 0x04 printer-attrs / 0x05 unsupported/job-attrs(响应)
 *
 * 属性（多值属性同名追加 value）：
 *   value-tag(1B) name-length(2B) name value-length(2B) value
 *   追加值：value-tag(1B) name-length=0(2B) value-length(2B) value
 *
 * 本模块同时提供：
 *   - 请求/响应编码（Virtual IPP Server 的响应也复用此处编码器）
 *   - 响应解码（严格边界检查；end-tag 之后的数据即文档数据）
 */

export const IPP_VERSION_MAJOR = 0x01
export const IPP_VERSION_MINOR = 0x01

/** 组分隔 tag（0x01–0x0F 均为组 tag，其余为值 tag） */
export const GROUP_OPERATION = 0x01
export const GROUP_JOB = 0x02
export const GROUP_END = 0x03
export const GROUP_PRINTER = 0x04
/** 响应中的 job-attrs 组（按本项目约定使用 0x05；解码时 0x02/0x05 均按 job 组处理） */
export const GROUP_JOB_RESPONSE = 0x05
export const GROUP_UNSUPPORTED = 0x06

/** 值 tag */
export const TAG_INTEGER = 0x21
export const TAG_BOOLEAN = 0x22
export const TAG_ENUM = 0x23
export const TAG_DATETIME = 0x31
export const TAG_RESOLUTION = 0x32
export const TAG_RANGE = 0x33
export const TAG_TEXT = 0x41
export const TAG_NAME = 0x42
export const TAG_KEYWORD = 0x44
export const TAG_URI = 0x45
export const TAG_URI_SCHEME = 0x46
export const TAG_CHARSET = 0x47
export const TAG_NATURAL_LANGUAGE = 0x48
export const TAG_MIME = 0x49

/** 操作 id（RFC 8011） */
export const OP_PRINT_JOB = 0x0002
export const OP_CANCEL_JOB = 0x0008
export const OP_GET_JOB_ATTRIBUTES = 0x0009
export const OP_GET_JOBS = 0x000a
export const OP_GET_PRINTER_ATTRIBUTES = 0x000b
export const OP_VALIDATE_JOB = 0x000c

/** 常用状态码 */
export const STATUS_OK = 0x0000
export const STATUS_CLIENT_ERROR = 0x0400
export const STATUS_CLIENT_ERROR_BAD_REQUEST = 0x0400
export const STATUS_CLIENT_ERROR_NOT_FOUND = 0x0406
export const STATUS_CLIENT_ERROR_NOT_POSSIBLE = 0x0404
export const STATUS_SERVER_ERROR = 0x0500
export const STATUS_SERVER_ERROR_OPERATION_NOT_SUPPORTED = 0x0501

/** 状态码 → 可读名（尽力而为） */
const STATUS_NAMES: Record<number, string> = {
  0x0000: 'successful-ok',
  0x0002: 'successful-ok-ignored-subscriptions',
  0x0400: 'client-error-bad-request',
  0x0401: 'client-error-forbidden',
  0x0402: 'client-error-not-authenticated',
  0x0403: 'client-error-not-authorized',
  0x0404: 'client-error-not-possible',
  0x0405: 'client-error-timeout',
  0x0406: 'client-error-not-found',
  0x0407: 'client-error-gone',
  0x0408: 'client-error-request-entity-too-large',
  0x040b: 'client-error-document-format-not-supported',
  0x0410: 'client-error-operation-not-supported',
  0x0500: 'server-error-internal-error',
  0x0501: 'server-error-operation-not-supported',
  0x0502: 'server-error-service-unavailable',
  0x0503: 'server-error-version-not-supported',
}

export function statusName(code: number): string {
  return STATUS_NAMES[code] ?? `ipp-status-0x${code.toString(16).padStart(4, '0')}`
}

export function isSuccessCode(code: number): boolean {
  return code >= 0x0000 && code < 0x0300
}

// ---------------------------------------------------------------- 类型

export interface IppAttributeValue {
  tag: number
  data: Uint8Array
}

export interface IppAttribute {
  tag: number
  name: string
  values: IppAttributeValue[]
}

export interface IppGroup {
  tag: number
  attributes: IppAttribute[]
}

export interface IppMessage {
  versionMajor: number
  versionMinor: number
  /** 请求 = operation-id；响应 = status-code */
  code: number
  requestId: number
  groups: IppGroup[]
  /** end-tag 之后的文档数据（如 PDF） */
  data: Uint8Array
}

// ---------------------------------------------------------------- Writer

class Writer {
  private chunks: Uint8Array[] = []
  private length = 0

  u8(v: number): this {
    this.push(new Uint8Array([v & 0xff]))
    return this
  }

  u16(v: number): this {
    this.push(new Uint8Array([(v >> 8) & 0xff, v & 0xff]))
    return this
  }

  u32(v: number): this {
    this.push(new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]))
    return this
  }

  bytes(data: Uint8Array): this {
    this.push(data)
    return this
  }

  text(value: string): this {
    this.push(new TextEncoder().encode(value))
    return this
  }

  private push(chunk: Uint8Array): void {
    this.chunks.push(chunk)
    this.length += chunk.length
  }

  build(): Uint8Array {
    const out = new Uint8Array(this.length)
    let offset = 0
    for (const chunk of this.chunks) {
      out.set(chunk, offset)
      offset += chunk.length
    }
    return out
  }
}

// ---------------------------------------------------------------- Reader（严格边界检查）

class Reader {
  private pos = 0

  constructor(private readonly buf: Uint8Array) {}

  remaining(): number {
    return this.buf.length - this.pos
  }

  u8(): number {
    this.assert(1)
    return this.buf[this.pos++]!
  }

  u16(): number {
    this.assert(2)
    const v = (this.buf[this.pos]! << 8) | this.buf[this.pos + 1]!
    this.pos += 2
    return v
  }

  u32(): number {
    this.assert(4)
    const v =
      this.buf[this.pos]! * 0x1000000 + (((this.buf[this.pos + 1]! << 16) | (this.buf[this.pos + 2]! << 8)) | this.buf[this.pos + 3]!)
    this.pos += 4
    return v
  }

  bytes(n: number): Uint8Array {
    this.assert(n)
    const out = this.buf.slice(this.pos, this.pos + n)
    this.pos += n
    return out
  }

  str(n: number): string {
    if (n === 0) return ''
    return new TextDecoder('utf-8', { fatal: false }).decode(this.bytes(n))
  }

  rest(): Uint8Array {
    return this.bytes(this.remaining())
  }

  private assert(n: number): void {
    if (this.pos + n > this.buf.length) {
      throw new Error(`IPP 解码越界：需要 ${n} 字节 @offset=${this.pos}，仅有 ${this.buf.length - this.pos}（消息被截断或非法）`)
    }
  }
}

// ---------------------------------------------------------------- 编码

/** 编码用属性：name + 一组原始值（value tag 统一） */
export interface EncAttr {
  tag: number
  name: string
  values: Uint8Array[]
}

/** typed 属性构造器（值编码为 IPP 二进制） */
export const attr = {
  integer(name: string, v: number | number[]): EncAttr {
    const list = Array.isArray(v) ? v : [v]
    return { tag: TAG_INTEGER, name, values: list.map((n) => int32(n)) }
  },
  boolean(name: string, v: boolean): EncAttr {
    return { tag: TAG_BOOLEAN, name, values: [new Uint8Array([v ? 1 : 0])] }
  },
  enum(name: string, v: number): EncAttr {
    return { tag: TAG_ENUM, name, values: [int32(v)] }
  },
  range(name: string, min: number, max: number): EncAttr {
    const w = new Writer()
    w.bytes(int32(min)).bytes(int32(max))
    return { tag: TAG_RANGE, name, values: [w.build()] }
  },
  resolution(name: string, x: number, y: number, unit: 3 | 4 = 3): EncAttr {
    const w = new Writer()
    w.bytes(int32(x)).bytes(int32(y)).u8(unit)
    return { tag: TAG_RESOLUTION, name, values: [w.build()] }
  },
  dateTime(name: string, date: Date): EncAttr {
    return { tag: TAG_DATETIME, name, values: [encodeDateTime(date)] }
  },
  keyword(name: string, v: string | string[]): EncAttr {
    return textTagged(TAG_KEYWORD, name, v)
  },
  text(name: string, v: string | string[]): EncAttr {
    return textTagged(TAG_TEXT, name, v)
  },
  name(name: string, v: string | string[]): EncAttr {
    return textTagged(TAG_NAME, name, v)
  },
  uri(name: string, v: string | string[]): EncAttr {
    return textTagged(TAG_URI, name, v)
  },
  charset(name: string, v: string | string[]): EncAttr {
    return textTagged(TAG_CHARSET, name, v)
  },
  naturalLanguage(name: string, v: string | string[]): EncAttr {
    return textTagged(TAG_NATURAL_LANGUAGE, name, v)
  },
  mime(name: string, v: string | string[]): EncAttr {
    return textTagged(TAG_MIME, name, v)
  },
}

function textTagged(tag: number, name: string, v: string | string[]): EncAttr {
  const list = Array.isArray(v) ? v : [v]
  const encoder = new TextEncoder()
  return { tag, name, values: list.map((s) => encoder.encode(s)) }
}

function int32(v: number): Uint8Array {
  const w = new Writer()
  w.u32(v)
  return w.build()
}

/** RFC 2579 DateAndTime（11 字节） */
function encodeDateTime(date: Date): Uint8Array {
  const out = new Uint8Array(11)
  const year = date.getUTCFullYear()
  out[0] = (year >> 8) & 0xff
  out[1] = year & 0xff
  out[2] = date.getUTCMonth() + 1
  out[3] = date.getUTCDate()
  out[4] = date.getUTCHours()
  out[5] = date.getUTCMinutes()
  out[6] = date.getUTCSeconds()
  out[7] = Math.floor(date.getUTCMilliseconds() / 100)
  out[8] = 0x2b // '+' 方向
  out[9] = 0
  out[10] = 0
  return out
}

/** 单个属性编码（含多值追加：后续值 name-length=0） */
function encodeAttribute(a: EncAttr): Uint8Array {
  const nameBytes = new TextEncoder().encode(a.name)
  if (nameBytes.length > 0xffff) throw new Error(`IPP 属性名过长：${a.name}`)
  const w = new Writer()
  let first = true
  for (const value of a.values) {
    if (value.length > 0xffff) throw new Error(`IPP 属性值过长（${value.length}B）：${a.name}`)
    w.u8(a.tag)
    if (first) {
      w.u16(nameBytes.length)
      w.bytes(nameBytes)
      first = false
    } else {
      w.u16(0)
    }
    w.u16(value.length)
    w.bytes(value)
  }
  return w.build()
}

export interface EncGroup {
  tag: number
  attributes: EncAttr[]
}

function encodeGroups(w: Writer, groups: EncGroup[]): void {
  for (const group of groups) {
    if (group.attributes.length === 0) continue
    w.u8(group.tag)
    for (const a of group.attributes) {
      w.bytes(encodeAttribute(a))
    }
  }
}

export interface EncodeIppMessageInput {
  /** 请求 = operation-id；响应 = status-code */
  code: number
  requestId: number
  groups: EncGroup[]
  data?: Uint8Array
}

/** 编码请求或响应（同一函数：version 1.1 + code + request-id + groups + end + data） */
export function encodeIppMessage(input: EncodeIppMessageInput): Uint8Array {
  const w = new Writer()
  w.u8(IPP_VERSION_MAJOR)
  w.u8(IPP_VERSION_MINOR)
  w.u16(input.code)
  w.u32(input.requestId)
  encodeGroups(w, input.groups)
  w.u8(GROUP_END)
  if (input.data && input.data.length > 0) w.bytes(input.data)
  return w.build()
}

// ---------------------------------------------------------------- 解码

function isGroupTag(tag: number): boolean {
  return tag >= 0x01 && tag <= 0x0f
}

/** 判断组是否 job 属性组（请求 0x02 / 响应按约定 0x05，两者均接受） */
export function isJobGroup(group: IppGroup): boolean {
  return group.tag === GROUP_JOB || group.tag === GROUP_JOB_RESPONSE
}

/**
 * 解码 IPP 消息（请求或响应）。
 * - 严格校验长度字段与组边界
 * - 0x03 之后的数据作为 data 返回（通常为 PDF 文档）
 * - 缺失组头的属性容错归入隐式 operation 组（部分设备不规范）
 */
export function decodeIppMessage(bytes: Uint8Array): IppMessage {
  if (bytes.length < 8) throw new Error(`IPP 消息过短（${bytes.length}B，头部需 8B）`)
  const r = new Reader(bytes)
  const versionMajor = r.u8()
  const versionMinor = r.u8()
  const code = r.u16()
  const requestId = r.u32()
  const groups: IppGroup[] = []
  let data: Uint8Array = new Uint8Array(0)
  let group: IppGroup | null = null
  let lastAttr: IppAttribute | null = null

  while (r.remaining() > 0) {
    const tag = r.u8()
    if (tag === GROUP_END) {
      data = r.rest()
      break
    }
    if (isGroupTag(tag)) {
      group = { tag, attributes: [] }
      groups.push(group)
      lastAttr = null
      continue
    }
    // 值 tag：属性
    const nameLen = r.u16()
    const name = r.str(nameLen)
    const valueLen = r.u16()
    const value = r.bytes(valueLen)
    if (!group) {
      group = { tag: GROUP_OPERATION, attributes: [] }
      groups.push(group)
      lastAttr = null
    }
    if (nameLen === 0 && lastAttr) {
      // 同名属性的追加值
      lastAttr.values.push({ tag, data: value })
    } else {
      const a: IppAttribute = { tag, name, values: [{ tag, data: value }] }
      group.attributes.push(a)
      lastAttr = a
    }
  }
  return { versionMajor, versionMinor, code, requestId, groups, data }
}

// ---------------------------------------------------------------- 属性值读取

/** 在消息中查找属性（可选限定组 tag；printer-attrs → operation → job-attrs 顺序） */
export function findAttr(msg: IppMessage, name: string, groupTag?: number): IppAttribute | undefined {
  const order = [GROUP_PRINTER, GROUP_OPERATION, GROUP_JOB, GROUP_JOB_RESPONSE, GROUP_UNSUPPORTED]
  const groups =
    groupTag === undefined ? order.map((t) => msg.groups.filter((g) => g.tag === t)).flat() : msg.groups.filter((g) => g.tag === groupTag)
  for (const g of groups) {
    const found = g.attributes.find((a) => a.name === name)
    if (found) return found
  }
  return undefined
}

/** 查找全部同 tag 组（如 Get-Jobs 的多个 job 组） */
export function groupsOf(msg: IppMessage, groupTag: number): IppGroup[] {
  return msg.groups.filter((g) => g.tag === groupTag)
}

function firstValue(a: IppAttribute | undefined): IppAttributeValue | undefined {
  return a?.values[0]
}

export function attrInt(a: IppAttribute | undefined): number | null {
  const v = firstValue(a)
  if (!v || v.data.length !== 4) return null
  return readInt32(v.data, 0)
}

export function attrInts(a: IppAttribute | undefined): number[] {
  if (!a) return []
  const out: number[] = []
  for (const v of a.values) {
    if (v.data.length === 4) out.push(readInt32(v.data, 0))
  }
  return out
}

export function attrBool(a: IppAttribute | undefined): boolean | null {
  const v = firstValue(a)
  if (!v || v.data.length !== 1) return null
  return v.data[0]! !== 0
}

export function attrStr(a: IppAttribute | undefined): string | null {
  const v = firstValue(a)
  if (!v) return null
  return new TextDecoder('utf-8', { fatal: false }).decode(v.data)
}

export function attrStrs(a: IppAttribute | undefined): string[] {
  if (!a) return []
  const decoder = new TextDecoder('utf-8', { fatal: false })
  return a.values.map((v) => decoder.decode(v.data))
}

export function attrRange(a: IppAttribute | undefined): [number, number] | null {
  const v = firstValue(a)
  if (!v || v.data.length !== 8) return null
  return [readInt32(v.data, 0), readInt32(v.data, 4)]
}

export function attrResolution(a: IppAttribute | undefined): { x: number; y: number; unit: number } | null {
  const v = firstValue(a)
  if (!v || v.data.length !== 9) return null
  return { x: readInt32(v.data, 0), y: readInt32(v.data, 4), unit: v.data[8] ?? 3 }
}

/**
 * 解析 1setOf resolution 属性的**全部**值（printer-resolution-supported 是集合属性）。
 * 长度不为 9 的值跳过（解析失败不猜测，由调用方决定三态）。
 */
export function attrResolutions(a: IppAttribute | undefined): { x: number; y: number; unit: number }[] {
  if (!a) return []
  return a.values
    .filter((v) => v.data.length === 9)
    .map((v) => ({ x: readInt32(v.data, 0), y: readInt32(v.data, 4), unit: v.data[8] ?? 3 }))
}

function readInt32(data: Uint8Array, offset: number): number {
  const b = data.subarray(offset, offset + 4)
  // 有符号 big-endian（IPP integer 为补码）
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  return view.getInt32(0, false)
}
