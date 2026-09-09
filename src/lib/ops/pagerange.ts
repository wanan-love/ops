/**
 * 页面范围解析（前端孪生实现，与 host src/core/pagerange.ts 保持同一口径：
 * 区间算术、越界裁剪、归一化、去重合并）。用于打印页提交前预览与内联校验——
 * 服务端（POST /api/jobs）仍是权威校验，此处仅提前反馈，避免一次注定失败的往返。
 */
export interface PageRangeParse {
  ok: boolean
  count: number
  normalized: string | null
  error: string | null
}

function parseSegment(segment: string): [number, number] | null {
  const s = segment.trim()
  if (s === '') return null
  const rangeMatch = /^(\d+)\s*-\s*(\d+)$/.exec(s)
  if (rangeMatch) {
    const a = Number(rangeMatch[1])
    const b = Number(rangeMatch[2])
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 1 || b < 1) return null
    return [Math.min(a, b), Math.max(a, b)]
  }
  const singleMatch = /^(\d+)$/.exec(s)
  if (singleMatch) {
    const n = Number(singleMatch[1])
    if (!Number.isSafeInteger(n) || n < 1) return null
    return [n, n]
  }
  return null
}

export function parsePageRange(range: string, totalPages: number): PageRangeParse {
  const raw = range.trim()
  if (raw === '') return { ok: false, count: 0, normalized: null, error: '页面范围为空' }
  if (!Number.isSafeInteger(totalPages) || totalPages < 1) return { ok: false, count: 0, normalized: null, error: '页数未知，无法应用页面范围' }

  const segments = raw.split(',')
  if (segments.length > 32) return { ok: false, count: 0, normalized: null, error: '页面范围段数过多（最多 32 段）' }

  const intervals: Array<[number, number]> = []
  for (const seg of segments) {
    const parsed = parseSegment(seg)
    if (!parsed) return { ok: false, count: 0, normalized: null, error: `格式无效：「${seg.trim()}」（示例：1-3,5）` }
    const lo = Math.max(parsed[0], 1)
    const hi = Math.min(parsed[1], totalPages)
    if (lo <= hi) intervals.push([lo, hi])
  }
  if (intervals.length === 0) {
    return { ok: false, count: 0, normalized: null, error: `范围超出文档页数（共 ${totalPages} 页）` }
  }

  intervals.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const [lo, hi] of intervals) {
    const last = merged[merged.length - 1]
    if (last && lo <= last[1] + 1) {
      last[1] = Math.max(last[1], hi)
    } else {
      merged.push([lo, hi])
    }
  }

  const count = merged.reduce((n, [lo, hi]) => n + (hi - lo + 1), 0)
  const normalized = merged.map(([lo, hi]) => (lo === hi ? `${lo}` : `${lo}-${hi}`)).join(',')
  return { ok: true, count, normalized, error: null }
}
