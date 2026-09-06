import type { Capability, CapabilityProbe, CapabilityReport, CapabilitySource, PrinterCapabilities } from '../core/types'

/**
 * 能力合并器（Capability Merger）。
 *
 * 多来源（IPP / CUPS / SNMP / SYSTEM …）各自产生 CapabilityReport 后在此合并：
 *  - 逐能力：已知（supported/unsupported）优先于 unknown；同已知度时按来源优先级 IPP > CUPS > WSD > SNMP > VENDOR_API > SYSTEM
 *  - probes 全部保留（失败也记录，用于 UI 展示“哪些来源探测失败”）
 *
 * 关键原则（用户红线）：
 *  - 读取不到 ≠ 不支持：unknown 永远不升级/降级为具体值
 *  - 单来源失败不影响其它能力与打印机可用性
 */

/** 来源优先级（可参数化） */
export const DEFAULT_SOURCE_PRIORITY: CapabilitySource[] = ['IPP', 'CUPS', 'WSD', 'SNMP', 'VENDOR_API', 'SYSTEM', 'UNKNOWN']

function nowIso(): string {
  return new Date().toISOString()
}

export function unknownCap<T>(source: CapabilitySource, detail?: string): Capability<T> {
  return { value: null, state: 'unknown', source, timestamp: nowIso(), detail }
}

export function supportedCap<T>(value: T, source: CapabilitySource, detail?: string): Capability<T> {
  return { value, state: 'supported', source, timestamp: nowIso(), detail }
}

export function unsupportedCap<T>(source: CapabilitySource, detail?: string): Capability<T> {
  return { value: null, state: 'unsupported', source, timestamp: nowIso(), detail }
}

/** 全 unknown 的空报告（某来源探测失败时使用，probes 由调用方补充） */
export function emptyReport(source: CapabilitySource, detail?: string): CapabilityReport {
  return {
    color: unknownCap(source, detail),
    duplex: unknownCap(source, detail),
    maxCopies: unknownCap(source, detail),
    paperSizes: unknownCap(source, detail),
    maxResolutionDpi: unknownCap(source, detail),
    ppm: unknownCap(source, detail),
    consumables: unknownCap(source, detail),
    probes: [],
  }
}

export interface ReportInput {
  source: CapabilitySource
  report: CapabilityReport
}

/** 探测失败报告（带一条失败 probe，保留失败原因） */
export function errorReport(source: CapabilitySource, error: string): CapabilityReport {
  const report = emptyReport(source, error)
  report.probes.push({ source, ok: false, durationMs: 0, error, at: nowIso() })
  return report
}

function pickCap<T>(inputs: ReportInput[], key: keyof CapabilityReport, rank: (s: CapabilitySource) => number): Capability<T> {
  const candidates = inputs.map((input, idx) => ({ cap: input.report[key] as Capability<T>, idx }))
  // 排序：已知态在前（unknown 永远排在已知之后）→ 来源优先级小者在前 → 输入顺序在前（新报告优先覆盖旧值）
  candidates.sort((a, b) => {
    const known = (c: Capability<T>): number => (c.state === 'unknown' ? 1 : 0)
    const byKnown = known(a.cap) - known(b.cap)
    if (byKnown !== 0) return byKnown
    const bySource = rank(a.cap.source) - rank(b.cap.source)
    if (bySource !== 0) return bySource
    return a.idx - b.idx
  })
  return candidates[0].cap
}

/**
 * 合并多来源 CapabilityReport。
 * 输入顺序即同优先级时的覆盖顺序（先传入的新报告优先于后传入的旧报告/兜底）。
 */
export function mergeReports(inputs: ReportInput[], sourcePriority: CapabilitySource[] = DEFAULT_SOURCE_PRIORITY): CapabilityReport {
  const rank = (s: CapabilitySource): number => {
    const i = sourcePriority.indexOf(s)
    return i < 0 ? sourcePriority.length : i
  }
  const probes: CapabilityProbe[] = []
  for (const input of inputs) {
    for (const probe of input.report.probes ?? []) probes.push(probe)
  }
  return {
    color: pickCap(inputs, 'color', rank),
    duplex: pickCap(inputs, 'duplex', rank),
    maxCopies: pickCap(inputs, 'maxCopies', rank),
    paperSizes: pickCap(inputs, 'paperSizes', rank),
    maxResolutionDpi: pickCap(inputs, 'maxResolutionDpi', rank),
    ppm: pickCap(inputs, 'ppm', rank),
    consumables: pickCap(inputs, 'consumables', rank),
    probes,
  }
}

/**
 * 报告 → 提交钳制用的 PrinterCapabilities。
 * unknown 不钳制成最小值（用户原则：读取不到 ≠ 不支持）：
 *  - color unknown → true（允许提交，交给驱动判断）
 *  - duplex unknown → 'both'（允许提交，UI 会提示）
 *  - maxCopies unknown → 50 保守值；paperSizes unknown → ['A4','Letter']
 */
export function resolveEffectiveCaps(report: CapabilityReport): PrinterCapabilities {
  const color: boolean =
    report.color.state === 'supported' ? report.color.value === true : report.color.state === 'unsupported' ? false : true
  const duplex: PrinterCapabilities['duplex'] =
    report.duplex.state === 'supported' ? (report.duplex.value ?? 'both') : report.duplex.state === 'unsupported' ? 'none' : 'both'
  const maxCopies: number =
    report.maxCopies.state === 'supported' && typeof report.maxCopies.value === 'number' && report.maxCopies.value > 0
      ? Math.floor(report.maxCopies.value)
      : report.maxCopies.state === 'unsupported'
        ? 1
        : 50
  const paperSizes: string[] =
    report.paperSizes.state === 'supported' && Array.isArray(report.paperSizes.value) && report.paperSizes.value.length > 0
      ? report.paperSizes.value
      : report.paperSizes.state === 'unsupported'
        ? ['A4']
        : ['A4', 'Letter']
  const maxResolutionDpi: number =
    report.maxResolutionDpi.state === 'supported' && typeof report.maxResolutionDpi.value === 'number' && report.maxResolutionDpi.value > 0
      ? Math.floor(report.maxResolutionDpi.value)
      : 600
  const ppm: number =
    report.ppm.state === 'supported' && typeof report.ppm.value === 'number' && report.ppm.value > 0 ? Math.floor(report.ppm.value) : 12
  return { color, duplex, maxCopies, paperSizes, maxResolutionDpi, ppm }
}

/** 生成一条成功 probe */
export function okProbe(source: CapabilitySource, durationMs: number): CapabilityProbe {
  return { source, ok: true, durationMs, at: nowIso() }
}

/** 生成一条失败 probe */
export function failProbe(source: CapabilitySource, durationMs: number, error: string): CapabilityProbe {
  return { source, ok: false, durationMs, error, at: nowIso() }
}
