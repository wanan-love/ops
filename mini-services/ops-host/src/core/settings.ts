import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import type { HostSettings } from './types'
import type { FileStorage } from './storage'

const REL = 'settings.json'

/** Host 设置（hostId 首次生成后持久化） */
export class SettingsStore {
  private settings!: HostSettings

  constructor(private readonly storage: FileStorage) {}

  async load(): Promise<HostSettings> {
    this.settings = await this.storage.readJson<HostSettings>(REL, {
      hostId: randomUUID(),
      hostName: `OPS-Host (${hostname()})`,
      securityMode: 'open',
    })
    await this.storage.writeJson(REL, this.settings)
    return this.settings
  }

  get(): HostSettings {
    return { ...this.settings }
  }

  async patch(patch: Partial<Pick<HostSettings, 'hostName' | 'securityMode' | 'snmpCommunity'>>): Promise<HostSettings> {
    this.settings = { ...this.settings, ...patch }
    await this.storage.writeJson(REL, this.settings)
    return this.get()
  }
}
