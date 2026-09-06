import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { promises as fs } from 'node:fs'
import type { HostSettings } from './types'
import type { FileStorage } from './storage'

const REL = 'settings.json'
const TOKEN_FILE = 'console-token.txt'

/** 控制台令牌格式：ops_ + 48 hex（192-bit 熵） */
export const CONSOLE_TOKEN_PREFIX = 'ops_'

export function generateConsoleToken(): string {
  return CONSOLE_TOKEN_PREFIX + randomBytes(24).toString('hex')
}

/** 常时时间比较（长度不同直接 false；令牌长度本身不敏感） */
export function safeTokenEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/** Host 设置（hostId 首次生成后持久化） */
export class SettingsStore {
  private settings!: HostSettings

  constructor(
    private readonly storage: FileStorage,
    /** 防锁定：令牌同步落盘到数据目录，Host 所有者可随时恢复 */
    private readonly onTokenIssued?: (token: string, reason: 'enable' | 'regenerate') => void,
  ) {}

  async load(): Promise<HostSettings> {
    this.settings = await this.storage.readJson<HostSettings>(REL, {
      hostId: randomUUID(),
      hostName: `OPS-Host (${hostname()})`,
      securityMode: 'open',
    })
    // 修复历史数据：PATCH 曾把未传字段抹为 undefined（hostName/snmpCommunity 从磁盘消失）→ 补默认值
    if (typeof this.settings.hostName !== 'string' || this.settings.hostName === '') {
      this.settings.hostName = `OPS-Host (${hostname()})`
    }
    if (!this.settings.consoleAuth) this.settings.consoleAuth = { enabled: false, token: null }
    // 修复历史数据：禁用态不允许残留令牌（启用时总是全新生成，禁用期间的旧值无意义且防泄露）
    if (!this.settings.consoleAuth.enabled) this.settings.consoleAuth.token = null
    await this.storage.writeJson(REL, this.settings)
    return this.settings
  }

  get(): HostSettings {
    const ca = this.settings.consoleAuth
    return { ...this.settings, consoleAuth: { enabled: ca?.enabled === true, token: ca?.token ?? null } }
  }

  /** 部分更新：仅覆盖显式传入的字段（未传字段保持原值——历史 bug 曾把 undefined 混入导致 hostName/snmpCommunity 被抹掉） */
  async patch(patch: Partial<Pick<HostSettings, 'hostName' | 'securityMode' | 'snmpCommunity' | 'pjlProbeEnabled' | 'pjlPort'>>): Promise<HostSettings> {
    const next: HostSettings = { ...this.settings }
    if (patch.hostName !== undefined) next.hostName = patch.hostName
    if (patch.securityMode !== undefined) next.securityMode = patch.securityMode
    if (patch.snmpCommunity !== undefined) next.snmpCommunity = patch.snmpCommunity
    if (patch.pjlProbeEnabled !== undefined) next.pjlProbeEnabled = patch.pjlProbeEnabled === true
    if (patch.pjlPort !== undefined) {
      // 1-65535 整数（真实设备 9100；测试环境 Virtual PJL 3067）。非法值不改（路由层已 400，此处兜底）
      const p = Math.floor(Number(patch.pjlPort))
      next.pjlPort = Number.isFinite(p) && p >= 1 && p <= 65535 ? p : 9100
    }
    this.settings = next
    await this.storage.writeJson(REL, this.settings)
    return this.get()
  }

  // ---------------------------------------------------------------- 控制台访问控制（P2 安全轮）

  consoleAuthEnabled(): boolean {
    return this.settings.consoleAuth?.enabled === true && typeof this.settings.consoleAuth.token === 'string'
  }

  /** 启用控制台鉴权：总是生成全新令牌（禁用期间旧值视为已泄露） */
  async enableConsoleAuth(): Promise<string> {
    const token = generateConsoleToken()
    this.settings.consoleAuth = { enabled: true, token }
    await this.persistTokenFile(token)
    await this.storage.writeJson(REL, this.settings)
    this.onTokenIssued?.(token, 'enable')
    return token
  }

  async disableConsoleAuth(): Promise<void> {
    this.settings.consoleAuth = { enabled: false, token: null }
    await this.storage.writeJson(REL, this.settings)
    await this.removeTokenFile().catch(() => {})
  }

  /** 重生成令牌（旧令牌立即失效） */
  async regenerateConsoleToken(): Promise<string> {
    const token = generateConsoleToken()
    this.settings.consoleAuth = { enabled: true, token }
    await this.persistTokenFile(token)
    await this.storage.writeJson(REL, this.settings)
    this.onTokenIssued?.(token, 'regenerate')
    return token
  }

  verifyConsoleToken(token: string | null | undefined): boolean {
    if (!this.consoleAuthEnabled()) return true
    if (typeof token !== 'string' || token.length === 0) return false
    return safeTokenEqual(token, this.settings.consoleAuth!.token as string)
  }

  /** 当前令牌（仅已授权上下文可展示；禁用态为 null） */
  consoleToken(): string | null {
    if (!this.consoleAuthEnabled()) return null
    return this.settings.consoleAuth!.token ?? null
  }

  private async persistTokenFile(token: string): Promise<void> {
    const path = join(this.storage.dataDir, TOKEN_FILE)
    await fs.writeFile(path, token + '\n', { mode: 0o600 })
  }

  private async removeTokenFile(): Promise<void> {
    await fs.rm(join(this.storage.dataDir, TOKEN_FILE), { force: true })
  }
}
