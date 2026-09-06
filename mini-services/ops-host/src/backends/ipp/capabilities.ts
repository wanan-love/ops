import type { CapabilityReport, CapabilitySource, ConsumableInfo, PrinterStatus } from '../../core/types'
import { failProbe, okProbe, supportedCap, unknownCap, emptyReport } from '../merge'
import { findAttr, attrInt, attrBool, attrStr, attrStrs, attrInts, attrRange, attrResolution } from './protocol'
import type { IppMessage } from './protocol'

/**
 * IPP Get-Printer-Attributes 响应 → CapabilityReport。
 *
 * 关键语义（用户红线）：
 *  - 属性存在 → supported/unsupported（如 color-supported=false 是“明确不支持”）
 *  - 属性缺失 → unknown（读取不到 ≠ 不支持；如 vipp-basic 无 sides-supported → duplex UNKNOWN）
 *  - marker-levels 缺失 → consumables UNKNOWN（UI 隐藏耗材模块，不显示假 0%）
 */

/** IPP marker-types keyword → ConsumableInfo.kind */
function markerKindOf(keyword: string): ConsumableInfo['kind'] {
  switch (keyword) {
    case 'toner':
    case 'toner-cartridge':
      return 'toner'
    case 'ink':
    case 'ink-cartridge':
      return 'ink'
    case 'drum':
    case 'photoconductor':
      return 'drum'
    case 'fuser':
    case 'maintenance-kit':
      return 'maintenance-kit'
    default:
      return 'other'
  }
}

/** 从 Get-Printer-Attributes 响应解析能力报告（source 由调用方指定：IPP / CUPS） */
export function reportFromPrinterAttributes(msg: IppMessage, source: CapabilitySource, durationMs = 0): CapabilityReport {
  const color = findAttr(msg, 'color-supported')
  const colorCap: CapabilityReport['color'] =
    color === undefined
      ? unknownCap(source, 'color-supported 属性不存在')
      : attrBool(color) === true
        ? supportedCap(true, source, 'IPP color-supported=true')
        : attrBool(color) === false
          ? supportedCap(false, source, 'IPP color-supported=false')
          : unknownCap(source, 'color-supported 值无法解析')

  const sides = findAttr(msg, 'sides-supported')
  let duplexCap: CapabilityReport['duplex']
  if (sides === undefined) {
    duplexCap = unknownCap(source, 'sides-supported 属性不存在')
  } else {
    const values = attrStrs(sides)
    const hasLong = values.includes('two-sided-long-edge')
    const hasShort = values.includes('two-sided-short-edge')
    if (!hasLong && !hasShort) {
      duplexCap = supportedCap('none', source, `IPP sides-supported=[${values.join(',')}]`)
    } else {
      const value = hasLong && hasShort ? 'both' : hasLong ? 'long-edge' : 'short-edge'
      duplexCap = supportedCap(value, source, `IPP sides-supported=[${values.join(',')}]`)
    }
  }

  const copies = findAttr(msg, 'copies-supported')
  const copiesRange = copies === undefined ? null : attrRange(copies)
  const maxCopiesCap: CapabilityReport['maxCopies'] =
    copiesRange === null
      ? unknownCap(source, 'copies-supported 属性不存在')
      : supportedCap(Math.max(1, copiesRange[1]), source, `IPP copies-supported=${copiesRange[0]}..${copiesRange[1]}`)

  const media = findAttr(msg, 'media-supported')
  const mediaValues = media === undefined ? null : attrStrs(media)
  const paperSizesCap: CapabilityReport['paperSizes'] =
    mediaValues === null || mediaValues.length === 0
      ? unknownCap(source, 'media-supported 属性不存在')
      : supportedCap(mediaValues, source, `IPP media-supported=[${mediaValues.join(',')}]`)

  const resolution = findAttr(msg, 'printer-resolution-supported')
  const dpiCap: CapabilityReport['maxResolutionDpi'] =
    resolution === undefined
      ? unknownCap(source, 'printer-resolution-supported 属性不存在')
      : supportedCap(attrResolution(resolution)?.x ?? 600, source, 'IPP printer-resolution-supported')

  const ppm = findAttr(msg, 'printer-pages-per-minute')
  const ppmValue = ppm === undefined ? null : attrInt(ppm)
  const ppmCap: CapabilityReport['ppm'] =
    ppmValue === null || ppmValue <= 0
      ? unknownCap(source, 'printer-pages-per-minute 属性不存在')
      : supportedCap(ppmValue, source, 'IPP printer-pages-per-minute')

  // 耗材：marker-levels（+ types/names/colors）全部缺失 → UNKNOWN
  const markerLevels = findAttr(msg, 'marker-levels')
  const levels = markerLevels === undefined ? null : attrInts(markerLevels)
  const types = attrStrs(findAttr(msg, 'marker-types'))
  const names = attrStrs(findAttr(msg, 'marker-names'))
  const colors = attrStrs(findAttr(msg, 'marker-colors'))
  let consumablesCap: CapabilityReport['consumables']
  if (levels === null || levels.length === 0) {
    consumablesCap = unknownCap(source, 'marker-levels 属性不存在（耗材不可读，UI 应隐藏耗材模块）')
  } else {
    const supplies: ConsumableInfo[] = levels.map((level, i) => ({
      name: names[i] ?? `Supply ${i + 1}`,
      kind: markerKindOf(types[i] ?? 'other'),
      color: colors[i],
      // IPP marker-levels 语义：-3 unknown / -2 remaining(非精确) / -1..100 百分比
      levelPct: level >= 0 && level <= 100 ? level : null,
      source,
    }))
    consumablesCap = supportedCap(supplies, source, `IPP marker-levels=[${levels.join(',')}]`)
  }

  return {
    color: colorCap,
    duplex: duplexCap,
    maxCopies: maxCopiesCap,
    paperSizes: paperSizesCap,
    maxResolutionDpi: dpiCap,
    ppm: ppmCap,
    consumables: consumablesCap,
    probes: [okProbe(source, durationMs)],
  }
}

/** 探测失败 → 全 UNKNOWN 报告 + 失败 probe（明确错误原因，不猜测能力） */
export function reportFromError(source: CapabilitySource, error: string, durationMs = 0): CapabilityReport {
  const report = emptyReport(source, error)
  report.probes.push(failProbe(source, durationMs, error))
  return report
}

/**
 * Get-Printer-Attributes 响应 → 打印机状态映射。
 * printer-state: 3 idle → online / 4 processing → busy / 5 stopped → 按 reasons 细分。
 * reasons：media-needed|media-empty → paper-out；media-jam → paper-jam；shutdown|connecting-to-device|timed-out → offline；其它非 none → error。
 */
export function statusFromPrinterAttributes(msg: IppMessage): { status: PrinterStatus; message: string } {
  const state = attrInt(findAttr(msg, 'printer-state')) ?? 0
  const reasons = attrStrs(findAttr(msg, 'printer-state-reasons')).map((r) => r.replace(/^printer-/, ''))
  const stateMessage = attrStr(findAttr(msg, 'printer-state-message')) ?? ''
  const makeAndModel = attrStr(findAttr(msg, 'printer-make-and-model')) ?? ''
  const suffix = makeAndModel ? `（${makeAndModel}）` : ''

  if (state === 3) {
    return { status: 'online', message: stateMessage || `IPP printer-state=idle${suffix}` }
  }
  if (state === 4) {
    return { status: 'busy', message: stateMessage || `IPP printer-state=processing${suffix}` }
  }
  if (state === 5) {
    for (const reason of reasons) {
      if (reason === 'media-needed' || reason === 'media-empty' || reason === 'media-low') {
        return { status: 'paper-out', message: stateMessage || `IPP printer-state-reasons=${reason}（缺纸）` }
      }
      if (reason === 'media-jam') {
        return { status: 'paper-jam', message: stateMessage || `IPP printer-state-reasons=${reason}（卡纸）` }
      }
      if (reason === 'shutdown' || reason === 'connecting-to-device' || reason === 'timed-out' || reason === 'offline') {
        return { status: 'offline', message: stateMessage || `IPP printer-state-reasons=${reason}（离线/不可达）` }
      }
    }
    return { status: 'error', message: stateMessage || `IPP printer-state=stopped，reasons=[${reasons.join(',')}]${suffix}` }
  }
  return { status: 'offline', message: `IPP printer-state=${state}（未知状态值）` }
}
