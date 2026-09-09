/**
 * 页面范围解析（提交前预览 / REST 校验 / 后端转发共用的单一口径）。
 *
 * 语法：逗号分隔的段，每段为单页 "5" 或区间 "1-3"；空白容忍；"3-1" 归一化为 "1-3"；
 * 区间与单页可混用（"1-3,5,8-9"）；越界页静默裁剪到文档页数（与 IPP page-ranges 语义一致：
 * "1-99" 的 2 页文档 = 打印 1-2），裁剪后无任何有效页 → 视为无效（而非默默打印 0 页）。
 *
 * 实现为区间算术（[start,end] 闭区间求并），O(段数) 且不随页数展开——
 * "1-999999999" 这类极端区间无内存风险。
 *
 * 返回 normalized 供存档与转发（排序去重后的紧凑形式），count 供页数/张数预估。
 * 解析失败返回 ok:false + 人话错误（REST 层据此 400，前端据此内联提示）。
 */
export interface PageRangeParse {
  ok: boolean
  /** 选中页数（区间求并后） */
  count: number
  /** 归一化紧凑形式（如 "1-3,5"）；ok:false 时为 null */
  normalized: string | null
  /** ok:false 时的人话错误 */
  error: string | null
}

/** 解析段（单段）：返回闭区间 [min,max] 或 null（语法非法） */
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
  if (!Number.isSafeInteger(totalPages) || totalPages < 1) return { ok: false, count: 0, normalized: null, error: '文档页数未知，无法应用页面范围' }

  const segments = raw.split(',')
  if (segments.length > 32) return { ok: false, count: 0, normalized: null, error: '页面范围段数过多（最多 32 段）' }

  const intervals: Array<[number, number]> = []
  for (const seg of segments) {
    const parsed = parseSegment(seg)
    if (!parsed) return { ok: false, count: 0, normalized: null, error: `页面范围格式无效：「${seg.trim()}」（示例：1-3,5）` }
    // 越界裁剪（与 IPP 语义一致：区间与 [1,totalPages] 求交）
    const lo = Math.max(parsed[0], 1)
    const hi = Math.min(parsed[1], totalPages)
    if (lo <= hi) intervals.push([lo, hi])
  }
  if (intervals.length === 0) {
    return { ok: false, count: 0, normalized: null, error: `页面范围超出文档页数（共 ${totalPages} 页）` }
  }

  // 区间求并（排序 + 合并重叠）→ 去重计数 + 紧凑形式
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
