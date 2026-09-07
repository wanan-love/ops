import { runCmd } from './cups'
import { detectRuntimePlatform } from '../core/runtime'

/**
 * Windows DeviceCapabilities API 适配（P5 —— VENDOR_RESEARCH.md 证据强度最高的下一步）。
 *
 * 数据来源：winspool.drv DeviceCapabilitiesA（微软官方 wingdi.h API，打印机驱动级真实能力）。
 * 与 WMI Win32_Printer 位掩码的差别（研究结论，见 docs/VENDOR_RESEARCH.md §3）：
 *  - DC_PAPERNAMES：驱动支持的完整纸型列表（WMI 只有 DefaultPaperType 单值）
 *  - DC_DUPLEX：可用的双面翻转模式（WMI 位 16 只说「支持双面」不区分长边/短边）
 *  - DC_COPIES：真实份数上限（WMI 位 32 只说「支持多份」）
 *  - DC_BINNAMES：纸盒/托盘列表（WMI 无对应字段）
 *  - DC_COLORDEVICE：驱动级彩色能力
 *
 * 实现路径：PowerShell Add-Type 内联 C# P/Invoke（单次调用查询全部 5 项能力）。
 *  - 仅 Windows 宿主执行（运行时检测；其它平台直接返回 null，不猜测）
 *  - 探测失败（驱动不支持/端口错/超时）→ 返回 null + 失败原因（调用方只记 probe，不覆盖既有值）
 *  - TTL 缓存（默认 10 分钟）：驱动能力不变，避免 autosync 60s 周期反复编译 Add-Type
 *
 * DeviceCapabilities 返回值语义（微软官方文档）：
 *  - pOutput=NULL 时返回所需元素数；失败返回 -1
 *  - DC_COLORDEVICE：1=彩色设备 / 0=黑白 / -1=失败
 *  - DC_DUPLEX：可用双面模式集合（DMDUP 语义：1=SIMPLEX 仅单面 / 2=VERTICAL 长边 / 3=HORIZONTAL 短边）
 *  - DC_COPIES：直接返回份数上限
 */

/** DC_* 常量（wingdi.h） */
const DC_BINS = 6
const DC_DUPLEX = 7
const DC_BINNAMES = 12
const DC_PAPERNAMES = 16
const DC_COPIES = 18
const DC_COLORDEVICE = 32
/** 纸型名固定宽度（CCHPAPERNAME=64，含结尾 null） */
const CCHPAPERNAME = 64
/** 纸盒名固定宽度（CCHBINNAME=24，含结尾 null） */
const CCHBINNAME = 24

const DC_TIMEOUT_MS = 15_000
const DC_CACHE_TTL_MS = 10 * 60_000

export interface DeviceCapsResult {
  ok: boolean
  /** DC_COLORDEVICE：true=彩色 / false=黑白 / null=读取失败（不覆盖既有值） */
  colorDevice: boolean | null
  /** DC_DUPLEX 原始值（位掩码语义见模块注释；null=读取失败） */
  duplexRaw: number | null
  /** DC_COPIES 真实份数上限（null=读取失败；-1 已转为 null） */
  maxCopies: number | null
  /** DC_PAPERNAMES 驱动级纸型列表（null=读取失败；空数组=驱动报告 0 项） */
  paperNames: string[] | null
  /** DC_BINNAMES 纸盒/托盘列表（null=读取失败） */
  binNames: string[] | null
  /** 诊断明细（原始返回值，供 UI / 日志核验） */
  detail: string
  durationMs: number
  /** 失败原因（ok=false 时） */
  error?: string
}

/** P/Invoke C# 侧（Add-Type 编译；无单引号字符——可安全嵌入 PS 单引号 here-string） */
const OPS_CAPS_CS = [
  'using System;',
  'using System.Runtime.InteropServices;',
  'public static class OpsCaps {',
  '  [DllImport("winspool.drv", CharSet=CharSet.Ansi, SetLastError=true)]',
  '  private static extern int DeviceCapabilities(string device, string port, ushort capability, IntPtr output, IntPtr devMode);',
  '  public static int QueryInt(string device, string port, ushort capability) {',
  '    return DeviceCapabilities(device, port, capability, IntPtr.Zero, IntPtr.Zero);',
  '  }',
  '  public static string[] QueryNames(string device, string port, ushort capability, int nameLen) {',
  '    int n = DeviceCapabilities(device, port, capability, IntPtr.Zero, IntPtr.Zero);',
  '    if (n <= 0) return null;',
  '    IntPtr buf = Marshal.AllocHGlobal(checked(n * nameLen));',
  '    try {',
  '      int r = DeviceCapabilities(device, port, capability, buf, IntPtr.Zero);',
  '      if (r <= 0) return null;',
  '      string[] names = new string[r];',
  '      for (int i = 0; i < r; i++) {',
  '        IntPtr p = new IntPtr(buf.ToInt64() + (long)i * nameLen);',
  '        string s = Marshal.PtrToStringAnsi(p, nameLen) ?? string.Empty;',
  '        int zero = s.IndexOf((char)0);',
  '        names[i] = zero >= 0 ? s.Substring(0, zero) : s;',
  '      }',
  '      return names;',
  '    } finally { Marshal.FreeHGlobal(buf); }',
  '  }',
  '}',
].join('\n')

/** 单引号字符串转义（PowerShell 单引号内 ' → ''） */
function psQuote(s: string): string {
  return s.replace(/'/g, "''")
}

function cleanNames(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null
  const cleaned = raw
    .map((n) => (typeof n === 'string' ? n.trim() : ''))
    .filter((n) => n.length > 0)
  return cleaned
}

/** TTL 缓存：printerName→结果（驱动能力不随时间变化；autosync 周期探测直接复用） */
const cache = new Map<string, { result: DeviceCapsResult; at: number }>()

export function clearDeviceCapsCache(): void {
  cache.clear()
}

/**
 * 查询一台打印机的驱动级能力（DeviceCapabilities）。
 * @param printerName Win32_Printer.Name（与驱动注册名一致）
 * @param portName Win32_Printer.PortName（可传空串——脚本内部会自动用 NULL 端口重试）
 * @returns 探测结果（非 Windows 平台直接返回 null，调用方保持 UNKNOWN 不猜测）
 */
export async function queryDeviceCapabilities(printerName: string, portName: string | null | undefined): Promise<DeviceCapsResult | null> {
  if (detectRuntimePlatform() !== 'windows') return null
  const cacheKey = `${printerName}\u0000${portName ?? ''}`
  const hit = cache.get(cacheKey)
  if (hit && Date.now() - hit.at < DC_CACHE_TTL_MS) return hit.result

  const startedAt = Date.now()
  const name = psQuote(printerName)
  const port = portName ? psQuote(portName) : ''
  // 端口失败自动重试：先用 WMI PortName 查询；三项 int 查询全部 -1 时改用 NULL 端口再查一次
  // （微软文档允许 pPort 为 NULL——部分驱动/重定向端口对 WMI PortName 敏感）
  const script = [
    '$ErrorActionPreference=\'Stop\'',
    'Add-Type -TypeDefinition @\'',
    OPS_CAPS_CS,
    '\'@',
    `$name='${name}'`,
    `$port='${port}'`,
    'function QueryAll([string]$p) {',
    '  $o=[ordered]@{}',
    `  $o.color=[OpsCaps]::QueryInt($name,$p,${DC_COLORDEVICE})`,
    `  $o.duplex=[OpsCaps]::QueryInt($name,$p,${DC_DUPLEX})`,
    `  $o.copies=[OpsCaps]::QueryInt($name,$p,${DC_COPIES})`,
    `  $o.papers=[OpsCaps]::QueryNames($name,$p,${DC_PAPERNAMES},${CCHPAPERNAME})`,
    `  $o.bins=[OpsCaps]::QueryNames($name,$p,${DC_BINNAMES},${CCHBINNAME})`,
    '  return $o',
    '}',
    '$out=QueryAll $port',
    '$nullPort=$false',
    'if (($out.color -lt 0) -and ($out.duplex -lt 0) -and ($out.copies -lt 0)) { $out=QueryAll $null; $nullPort=$true }',
    '$out | ConvertTo-Json -Compress',
  ].join('\n')

  let result: DeviceCapsResult
  const res = await runCmd('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], DC_TIMEOUT_MS)
  if (!res.ok) {
    result = {
      ok: false,
      colorDevice: null,
      duplexRaw: null,
      maxCopies: null,
      paperNames: null,
      binNames: null,
      detail: '',
      durationMs: Date.now() - startedAt,
      error: `DeviceCapabilities 查询失败：${(res.stderr || res.stdout).trim().slice(0, 300) || `exit=${res.code}`}`,
    }
  } else {
    try {
      const parsed = JSON.parse(res.stdout.trim()) as Record<string, unknown> | null
      if (!parsed) throw new Error('无输出')
      const color = typeof parsed.color === 'number' ? parsed.color : -1
      const duplex = typeof parsed.duplex === 'number' ? parsed.duplex : -1
      const copies = typeof parsed.copies === 'number' ? parsed.copies : -1
      result = {
        ok: true,
        colorDevice: color >= 0 ? color === 1 : null,
        duplexRaw: duplex >= 0 ? duplex : null,
        maxCopies: copies > 0 ? copies : null,
        paperNames: cleanNames(parsed.papers),
        binNames: cleanNames(parsed.bins),
        detail: `DeviceCapabilities：DC_COLORDEVICE=${color} / DC_DUPLEX=${duplex} / DC_COPIES=${copies} / DC_PAPERNAMES=${Array.isArray(parsed.papers) ? parsed.papers.length : 0} 项 / DC_BINNAMES=${Array.isArray(parsed.bins) ? parsed.bins.length : 0} 项（驱动级真实能力）`,
        durationMs: Date.now() - startedAt,
      }
    } catch (err) {
      result = {
        ok: false,
        colorDevice: null,
        duplexRaw: null,
        maxCopies: null,
        paperNames: null,
        binNames: null,
        detail: '',
        durationMs: Date.now() - startedAt,
        error: `DeviceCapabilities 响应解析失败：${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }
  cache.set(cacheKey, { result, at: Date.now() })
  return result
}

/**
 * DC_DUPLEX 原始值 → OPS duplex 能力值。
 * DMDUP 语义（DEVMODE 常量）：1=SIMPLEX（仅单面）/ 2=VERTICAL（长边翻转）/ 3=HORIZONTAL（短边翻转）。
 * ⚠️ 该返回值历史上同时存在「位掩码（1/2/4）」与「常量集合（1/2/3）」两种驱动实现：
 *  - 位掩码解释：bit1(2)=长边、bit2(4)=短边
 *  - 常量解释：3=短边可用（DMDUP_HORIZONTAL）
 * 双解释保守合并（长边 = bit1；短边 = bit2 或值恰为 3），原始值始终写入 detail 供真机核验。
 */
export function mapDcDuplex(raw: number): { value: 'none' | 'long-edge' | 'short-edge' | 'both' } | null {
  const long = (raw & 2) !== 0
  const short = (raw & 4) !== 0 || raw === 3
  if (long && short) return { value: 'both' }
  if (long) return { value: 'long-edge' }
  if (short) return { value: 'short-edge' }
  if (raw === 1) return { value: 'none' }
  // 0 或其它值：无法解释（不猜测）
  return null
}
