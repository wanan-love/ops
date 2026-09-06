import { randomUUID } from 'node:crypto'
import type { PairedDevice, PairingRequest, Platform } from './types'
import type { FileStorage } from './storage'
import type { EventBus } from './eventbus'
import type { EventLog } from './eventlog'
import type { SettingsStore } from './settings'

const DEVICES_REL = 'devices.json'
const PAIRING_REL = 'pairing.json'

export interface PairingInput {
  deviceId: string
  deviceName: string
  platform: Platform
}

/**
 * 基础设备配对：
 *  - open 模式：无需令牌即可打印（局域网信任，MVP 默认）
 *  - pairing 模式：设备发起请求 → Host 控制台审批 → 颁发设备令牌
 *    之后提交打印必须携带 X-OPS-Token
 */
export class PairingManager {
  private requests = new Map<string, PairingRequest>()
  private devices = new Map<string, PairedDevice>()

  constructor(
    private readonly storage: FileStorage,
    private readonly bus: EventBus,
    private readonly log: EventLog,
    private readonly settings: SettingsStore,
  ) {}

  async load(): Promise<void> {
    const devices = await this.storage.readJson<PairedDevice[]>(DEVICES_REL, [])
    this.devices = new Map(devices.map((d) => [d.deviceId, d]))
    const requests = await this.storage.readJson<PairingRequest[]>(PAIRING_REL, [])
    this.requests = new Map(requests.map((r) => [r.id, r]))
  }

  private async persist(): Promise<void> {
    await this.storage.writeJson(DEVICES_REL, [...this.devices.values()])
    await this.storage.writeJson(PAIRING_REL, [...this.requests.values()])
  }

  private broadcast(): void {
    this.bus.emit('pairing:update', { requests: this.listRequests(), devices: this.listDevices() })
  }

  createRequest(input: PairingInput): PairingRequest {
    // 同一设备的旧 pending 请求先失效
    for (const req of this.requests.values()) {
      if (req.deviceId === input.deviceId && req.status === 'pending') {
        req.status = 'rejected'
        req.resolvedAt = new Date().toISOString()
      }
    }
    const request: PairingRequest = {
      id: `pr-${randomUUID().slice(0, 8)}`,
      deviceId: input.deviceId,
      deviceName: input.deviceName,
      platform: input.platform,
      code: String(Math.floor(1000 + Math.random() * 9000)),
      status: 'pending',
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    }
    this.requests.set(request.id, request)
    void this.persist()
    this.log.record({ type: 'pairing', topic: 'request', message: `配对请求：${input.deviceName}（${input.platform}），验证码 ${request.code}` })
    this.broadcast()
    return request
  }

  listRequests(): PairingRequest[] {
    return [...this.requests.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50)
  }

  listDevices(): PairedDevice[] {
    return [...this.devices.values()].sort((a, b) => b.pairedAt.localeCompare(a.pairedAt))
  }

  getRequest(id: string): PairingRequest | undefined {
    return this.requests.get(id)
  }

  approve(id: string): { request: PairingRequest; token: string } | { error: string } {
    const request = this.requests.get(id)
    if (!request) return { error: '配对请求不存在' }
    if (request.status !== 'pending') return { error: `请求已处理（${request.status}）` }
    request.status = 'approved'
    request.resolvedAt = new Date().toISOString()
    const token = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '')
    const device: PairedDevice = {
      deviceId: request.deviceId,
      name: request.deviceName,
      platform: request.platform,
      token,
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    }
    this.devices.set(device.deviceId, device)
    void this.persist()
    this.log.record({ type: 'pairing', topic: 'approved', message: `设备已配对：${device.name}（${device.platform}）` })
    this.broadcast()
    return { request, token }
  }

  reject(id: string): { request: PairingRequest } | { error: string } {
    const request = this.requests.get(id)
    if (!request) return { error: '配对请求不存在' }
    if (request.status !== 'pending') return { error: `请求已处理（${request.status}）` }
    request.status = 'rejected'
    request.resolvedAt = new Date().toISOString()
    void this.persist()
    this.log.record({ type: 'pairing', topic: 'rejected', message: `配对请求已拒绝：${request.deviceName}` })
    this.broadcast()
    return { request }
  }

  revoke(deviceId: string): boolean {
    const device = this.devices.get(deviceId)
    if (!device) return false
    this.devices.delete(deviceId)
    void this.persist()
    this.log.record({ type: 'pairing', topic: 'revoked', message: `已解除设备配对：${device.name}` })
    this.broadcast()
    return true
  }

  /** 设备侧轮询自己的请求状态（批准后发放令牌） */
  statusFor(deviceId: string): { pending: PairingRequest[]; token: string | null; paired: boolean } {
    const mine = this.listRequests().filter((r) => r.deviceId === deviceId && r.status === 'pending')
    const device = this.devices.get(deviceId)
    return { pending: mine, token: device ? device.token : null, paired: !!device }
  }

  /** 安全模式校验：open → 一律放行；pairing → 校验令牌 */
  authorize(token: string | null | undefined): { ok: boolean; device: PairedDevice | null; reason?: string } {
    if (this.settings.get().securityMode === 'open') {
      if (token) {
        for (const device of this.devices.values()) {
          if (device.token === token) {
            device.lastSeenAt = new Date().toISOString()
            return { ok: true, device }
          }
        }
      }
      return { ok: true, device: null }
    }
    if (!token) return { ok: false, device: null, reason: '安全模式已开启：缺少 X-OPS-Token（请先完成设备配对）' }
    for (const device of this.devices.values()) {
      if (device.token === token) {
        device.lastSeenAt = new Date().toISOString()
        return { ok: true, device }
      }
    }
    return { ok: false, device: null, reason: '无效的设备令牌' }
  }
}
