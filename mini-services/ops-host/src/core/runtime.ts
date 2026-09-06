import { existsSync } from 'node:fs'
import { release, type, version } from 'node:os'

/**
 * 运行时平台动态检测（真实性红线模块）。
 *
 * 原则：
 *  - 平台必须由「实际运行环境」决定，禁止使用开发环境/编译环境的固定值；
 *  - 多信号交叉验证，优先级（高 → 低）：
 *    1. process.env.OS === 'Windows_NT'（Windows 系统自身注入的运行时环境变量，
 *       bun build 绝不内联——编译期无法伪造）
 *    2. /proc/version 存在（Linux 内核运行时特征文件）
 *    3. /System/Library/CoreServices/SystemVersion.plist 存在（macOS 运行时特征文件）
 *    4. process.platform（Bun --target 交叉编译时等于「编译目标」而非宿主——
 *       仅在前三个信号全部缺失时才作为兜底；正常部署下与宿主一致）
 *    5. 终极兜底：linux（最保守判定，不覆盖任何已确认信号）
 *  - ⚠️ 文件系统特征探测（信号 2/3）优先于 process.platform 的原因：
 *    bun --target=windows-x64 产物内 process.platform 恒为 'win32'（编译目标），
 *    若该二进制被运行在非 Windows 宿主上（Wine/模拟层/误部署），
 *    特征文件探测仍能给出真实宿主判定 —— 这是「运行时检测」的实质保证。
 *  - 每个信号都记录来源，platformRuntimeDetail() 供 HostInfo/UI/日志展示，
 *    用户可核验「为什么判定为该平台」。
 */

export type RuntimePlatform = 'windows' | 'macos' | 'linux'

export interface RuntimePlatformDetail {
  /** 判定结果 */
  platform: RuntimePlatform
  /** 命中的检测信号（人类可读，供 UI / 日志核验） */
  signals: string[]
  /** 运行时 os.release()（Windows 形如 10.0.19045；Linux 内核版本；Darwin 内核版本） */
  release: string
  /** 运行时 os.version()（Windows 形如 "Windows 10 Home"；Linux/macOS 构建串） */
  version: string
  /** 运行时 os.type()（Windows_NT / Linux / Darwin） */
  type: string
}

/** 单次检测结果缓存（进程生命周期内不变——平台不会在运行中切换；但绝不跨进程持久化） */
let cachedDetail: RuntimePlatformDetail | null = null

export function detectRuntimePlatform(): RuntimePlatform {
  return runtimePlatformDetail().platform
}

/** 完整检测明细（含信号链 + os 运行时信息），缓存一次 */
export function runtimePlatformDetail(): RuntimePlatformDetail {
  if (cachedDetail) return cachedDetail
  const signals: string[] = []

  // 信号 1：Windows 宿主环境变量（运行时注入，编译期无法伪造）
  if (process.env.OS === 'Windows_NT' || process.env.PROCESSOR_ARCHITECTURE !== undefined) {
    signals.push(`env.OS=${process.env.OS ?? '未设置'} / env.PROCESSOR_ARCHITECTURE=${process.env.PROCESSOR_ARCHITECTURE ?? '未设置'}（Windows 宿主信号）`)
    cachedDetail = {
      platform: 'windows',
      signals,
      release: safeOs(release),
      version: safeOs(version),
      type: safeOs(type),
    }
    return cachedDetail
  }

  // 信号 2：Linux 内核运行时特征（文件系统真实探测，优先于 process.platform）
  if (existsSync('/proc/version')) {
    signals.push(`process.platform=${process.platform}`, '/proc/version 存在（Linux 内核特征）')
    cachedDetail = { platform: 'linux', signals, release: safeOs(release), version: safeOs(version), type: safeOs(type) }
    return cachedDetail
  }

  // 信号 3：macOS 运行时特征（CoreServices 目录仅存在于 macOS；探测失败不等于否定——兜底到信号 4）
  if (existsSync('/System/Library/CoreServices/SystemVersion.plist')) {
    signals.push(`process.platform=${process.platform}`, '/System/Library/CoreServices/SystemVersion.plist 存在（macOS 特征）')
    cachedDetail = { platform: 'macos', signals, release: safeOs(release), version: safeOs(version), type: safeOs(type) }
    return cachedDetail
  }

  // 信号 4：process.platform（交叉编译时为编译目标；前三信号缺失时兜底）
  const p = process.platform
  if (p === 'win32') {
    signals.push('process.platform=win32（无文件系统特征信号时的兜底判定）')
    cachedDetail = { platform: 'windows', signals, release: safeOs(release), version: safeOs(version), type: safeOs(type) }
    return cachedDetail
  }
  if (p === 'darwin') {
    signals.push('process.platform=darwin（无文件系统特征信号时的兜底判定）')
    cachedDetail = { platform: 'macos', signals, release: safeOs(release), version: safeOs(version), type: safeOs(type) }
    return cachedDetail
  }
  signals.push(`process.platform=${p}`)

  // 终极兜底（前三信号与 win32/darwin 均未命中；极罕见场景）
  signals.push('无更强信号 → 兜底 linux')
  cachedDetail = { platform: 'linux', signals, release: safeOs(release), version: safeOs(version), type: safeOs(type) }
  return cachedDetail
}

function safeOs(fn: () => string): string {
  try {
    return fn() || ''
  } catch {
    return ''
  }
}

/** 平台中文标签（UI 展示用） */
export function platformLabel(p: RuntimePlatform): string {
  return p === 'windows' ? 'Windows' : p === 'macos' ? 'macOS' : 'Linux'
}

/**
 * 开发/测试模式判定（正式产品与虚拟设备隔离的唯一开关）。
 *  - OPS_DEV_MODE=1 显式启用（bun run dev / 测试脚本注入；bun build 编译绝不内联环境变量）
 *  - 默认 0 = 正式模式：不注册 Mock 后端、不种虚拟打印机、不启动 vipp/vscan/vpjl
 */
export function isDevMode(): boolean {
  return process.env.OPS_DEV_MODE === '1'
}
