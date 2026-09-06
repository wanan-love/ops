import { existsSync } from 'node:fs'
import { release, type, version } from 'node:os'

/**
 * 运行时平台动态检测（真实性红线模块）。
 *
 * 原则：
 *  - 平台必须由「实际运行环境」决定，禁止使用开发环境/编译环境的固定值；
 *  - 多信号交叉验证：运行时环境变量（宿主 OS 注入，不可能被 bun build 内联）
 *    优先级高于 process.platform（bun --target 交叉编译时等于编译目标——
 *    目标平台正确运行时两者一致，异常场景下运行时信号更可信）；
 *  - 每个信号都记录来源，platformRuntimeDetail() 供 HostInfo/UI/日志展示，
 *    用户可核验「为什么判定为该平台」。
 *
 * 信号优先级（高 → 低）：
 *   1. process.env.OS === 'Windows_NT'（Windows 系统自身注入，运行时真实值）
 *   2. process.platform === 'win32' | 'darwin'（Bun 交叉编译目标；正常部署下与宿主一致）
 *   3. /proc/version 存在（Linux 内核运行时特征文件）
 *   4. 兜底：linux（最保守判定，不用于覆盖任何已确认信号）
 */

export type RuntimePlatform = 'windows' | 'macos' | 'linux'

export interface RuntimePlatformDetail {
  /** 判定结果 */
  platform: RuntimePlatform
  /** 命中的检测信号（人类可读，供 UI / 日志核验） */
  signals: string[]
  /** 运行时 os.release()（Windows 形如 10.0.19045；Linux 内核版本） */
  release: string
  /** 运行时 os.version()（Windows 形如 "Windows 10 Home"） */
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

  // 信号 2：process.platform（bun --target 交叉编译时等于编译目标；宿主即目标时正确）
  const p = process.platform
  if (p === 'win32') {
    signals.push('process.platform=win32')
    cachedDetail = { platform: 'windows', signals, release: safeOs(release), version: safeOs(version), type: safeOs(type) }
    return cachedDetail
  }
  if (p === 'darwin') {
    signals.push('process.platform=darwin')
    cachedDetail = { platform: 'macos', signals, release: safeOs(release), version: safeOs(version), type: safeOs(type) }
    return cachedDetail
  }
  signals.push(`process.platform=${p}`)

  // 信号 3：Linux 内核运行时特征（文件系统真实探测）
  if (existsSync('/proc/version')) {
    signals.push('/proc/version 存在（Linux 内核特征）')
    cachedDetail = { platform: 'linux', signals, release: safeOs(release), version: safeOs(version), type: safeOs(type) }
    return cachedDetail
  }

  // 兜底（信号不足时的最保守判定；process.platform 非 win32/darwin 且无 /proc 的场景极罕见）
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
