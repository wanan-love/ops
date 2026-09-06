import type { Platform } from '../core/types'

/**
 * PlatformAdapter — 平台适配器接口。
 * Core 不允许 import 平台 API；平台差异（发现响应器、系统打印枚举、原生对话框）
 * 全部通过本接口由各平台实现注入。
 */
export interface PlatformAdapter {
  platform: Platform
  detect(): Promise<Platform>
  localHostName(): string
  localAddresses(): string[]
  startDiscoveryResponder(): Promise<void>
  stopDiscoveryResponder(): Promise<void>
}

/**
 * 当前环境（Web Host / 沙箱）：Bun 运行时，平台能力由 DiscoveryService（UDP beacon）
 * 与 MockPrinterBackend 提供。真实平台适配器在阶段 8-10 逐步接入。
 */
export const currentPlatform: PlatformAdapter = {
  platform: 'web',
  async detect(): Promise<Platform> {
    return 'web'
  },
  localHostName(): string {
    return process.env.OPS_HOST_NAME ?? 'OPS-Host'
  },
  localAddresses(): string[] {
    return ['127.0.0.1']
  },
  async startDiscoveryResponder(): Promise<void> {
    /* 由 DiscoveryService 负责 */
  },
  async stopDiscoveryResponder(): Promise<void> {
    /* noop */
  },
}
