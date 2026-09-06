import { createSocket, type Socket } from 'node:dgram'
import { networkInterfaces } from 'node:os'
import type { DiscoveredHost } from './types'
import type { EventBus } from './eventbus'
import type { EventLog } from './eventlog'
import type { PrinterRegistry } from './printers'
import type { SettingsStore } from './settings'
import { OPS_API_VERSION, OPS_VERSION } from './types'
import { detectRuntimePlatform, isDevMode } from './runtime'

const BEACON_PORT = 44445
const BEACON_INTERVAL_MS = 5000
const HOST_TTL_MS = 30_000

/**
 * Discovery：局域网自动发现。
 *
 *  MVP 实现两部分：
 *   1. UDP Beacon（已内置，生产可用）：每 5s 向局域网广播 JSON 公告；
 *      同时监听并登记其它 OPS Host 的公告（TTL 30s）。
 *   2. HTTP 发现：Web 控制台经网关调用 /api/discovery/hosts 获取当前可见的 Host。
 *
 *  生产桌面版将替换为 Bonjour/Avahi（_ops._tcp + _ipp._tcp），Android 用
 *  NsdManager、iOS 用 NetServiceBrowser —— 协议层（DiscoveryService 接口）保持不变。
 */
export class DiscoveryService {
  private socket: Socket | null = null
  private beaconTimer: ReturnType<typeof setInterval> | null = null
  private seen = new Map<string, DiscoveredHost>()
  private broadcastFailed = false

  constructor(
    private readonly settings: SettingsStore,
    private readonly printers: PrinterRegistry,
    private readonly bus: EventBus,
    private readonly log: EventLog,
    private readonly restPort: number,
  ) {}

  start(): void {
    this.openSocket()
    this.beaconTimer = setInterval(() => this.announce(), BEACON_INTERVAL_MS)
    this.announce()
  }

  stop(): void {
    if (this.beaconTimer) clearInterval(this.beaconTimer)
    this.beaconTimer = null
    this.socket?.close()
    this.socket = null
  }

  private openSocket(): void {
    try {
      const socket = createSocket({ type: 'udp4', reuseAddr: true })
      socket.on('error', (err) => {
        if (!this.broadcastFailed) {
          this.broadcastFailed = true
          console.warn(`[discovery] UDP beacon unavailable in this environment: ${err.message}`)
        }
        try {
          socket.close()
        } catch {
          /* noop */
        }
      })
      socket.on('message', (buf) => {
        try {
          const msg = JSON.parse(buf.toString('utf8')) as { service?: string; hostId?: string }
          if (msg.service === 'openprintshare' && msg.hostId && msg.hostId !== this.settings.get().hostId) {
            // 其它 OPS Host 的公告（同机沙箱内不会出现，真实局域网生效）
          }
        } catch {
          /* ignore malformed */
        }
      })
      socket.bind(BEACON_PORT, () => {
        socket.setBroadcast(true)
        this.socket = socket
      })
    } catch (err) {
      console.warn('[discovery] UDP socket init failed:', err)
    }
  }

  localAddresses(): string[] {
    const results: string[] = []
    for (const list of Object.values(networkInterfaces())) {
      for (const net of list ?? []) {
        if (net.family === 'IPv4' && !net.internal) results.push(net.address)
      }
    }
    return results
  }

  selfInfo(): DiscoveredHost {
    const settings = this.settings.get()
    // 正式模式不广播虚拟打印机（防御性隔离；开发模式全量）
    const printers = this.printers.listAll().filter((p) => isDevMode() || !p.virtual)
    return {
      hostId: settings.hostId,
      hostName: settings.hostName,
      version: OPS_VERSION,
      apiVersion: OPS_API_VERSION,
      restPort: this.restPort,
      platform: detectRuntimePlatform(),
      printers: printers.length,
      sharedPrinters: printers.filter((p) => p.shared).length,
      addr: this.localAddresses()[0] ?? '127.0.0.1',
      source: 'self',
      lastSeenAt: new Date().toISOString(),
    }
  }

  hosts(): DiscoveredHost[] {
    const now = Date.now()
    const peers = [...this.seen.values()].filter((h) => now - new Date(h.lastSeenAt).getTime() < HOST_TTL_MS)
    return [this.selfInfo(), ...peers]
  }

  /** 立即广播一次公告（HTTP 发现触发时也会调用，便于演示） */
  announce(): void {
    const self = this.selfInfo()
    const payload = Buffer.from(
      JSON.stringify({ service: 'openprintshare', apiVersion: OPS_API_VERSION, version: OPS_VERSION, hostId: self.hostId, hostName: self.hostName, restPort: self.restPort }),
    )
    if (this.socket) {
      this.socket.send(payload, BEACON_PORT, '255.255.255.255', (err) => {
        if (err && !this.broadcastFailed) {
          this.broadcastFailed = true
          console.warn(`[discovery] broadcast failed (${err.message}) — HTTP discovery 仍可用`)
        }
      })
    }
    this.bus.emit('discovery:update', { hosts: this.hosts() })
    return
  }
}
