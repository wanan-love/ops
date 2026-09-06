import { randomUUID } from 'node:crypto'
import { FileStorage } from './core/storage'
import { EventBus } from './core/eventbus'
import { EventLog } from './core/eventlog'
import { SettingsStore } from './core/settings'
import { PrinterRegistry } from './core/printers'
import { JobManager } from './core/jobs'
import { VirtualPrintEngine } from './core/engine'
import { PairingManager } from './core/pairing'
import { DiscoveryService } from './core/discovery'
import { OPS_API_VERSION, OPS_VERSION } from './core/types'
import type { DiscoveredHost, HostInfo, OpsEvent, PairedDevice, PairingRequest, PrintJob, Printer, TestRun } from './core/types'
import type { SelfTestRunner } from './tests/selftest'

/** Host 门面上下文：所有模块的装配点（依赖注入，避免循环依赖） */
export interface HostContext {
  storage: FileStorage
  bus: EventBus
  log: EventLog
  settings: SettingsStore
  printers: PrinterRegistry
  jobs: JobManager
  engine: VirtualPrintEngine
  pairing: PairingManager
  discovery: DiscoveryService
  selfTest: SelfTestRunner
  restPort: number
  wsPort: number
  dataDir: string
  startedAt: number
  hostInfo(): HostInfo
  /** 模拟 Host 重启：停引擎 → 从磁盘重建内存状态 → 恢复进行中任务 */
  restartSimulated(): void
}

export interface HostOptions {
  restPort: number
  wsPort: number
  dataDir: string
}

export interface OpsHost {
  ctx: HostContext
  start(): Promise<void>
  dispose(): void
}

export async function createOpsHost(opts: HostOptions): Promise<OpsHost> {
  const { restPort, wsPort, dataDir } = opts

  const storage = new FileStorage(dataDir)
  await storage.init()

  const bus = new EventBus()
  const log = new EventLog(storage, bus)
  const settings = new SettingsStore(storage)
  await settings.load()

  const printers = new PrinterRegistry(storage, bus, log)
  await printers.load()

  const jobs = new JobManager(storage, bus, log)
  await jobs.load()

  const engine = new VirtualPrintEngine(printers, jobs, bus, log)
  const pairing = new PairingManager(storage, bus, log, settings)
  await pairing.load()

  const discovery = new DiscoveryService(settings, printers, bus, log, restPort)

  const startedAt = Date.now()

  const ctx: HostContext = {
    storage,
    bus,
    log,
    settings,
    printers,
    jobs,
    engine,
    pairing,
    discovery,
    selfTest: null as unknown as SelfTestRunner, // 稍后注入（selftest 依赖 ctx）
    restPort,
    wsPort,
    dataDir,
    startedAt,
    hostInfo(): HostInfo {
      const s = settings.get()
      return {
        service: 'openprintshare-host',
        hostId: s.hostId,
        hostName: s.hostName,
        version: OPS_VERSION,
        apiVersion: OPS_API_VERSION,
        platform: process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux',
        platformNote: '本演示运行于 Web Host 环境（Bun 运行时）——PlatformAdapter 已按平台解耦',
        backend: 'mock',
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
        securityMode: s.securityMode,
        restPort,
        wsPort,
        dataDir,
      }
    },
    restartSimulated(): void {
      engine.dispose()
      // 从磁盘重建内存状态（模拟宿主机重启）
      void (async () => {
        await printers.load()
        const loaded = await jobs.load()
        for (const job of loaded) {
          if (job.state === 'processing' || job.state === 'paused') {
            jobs.pushTimeline(job, {
              type: 'system',
              reason: 'host-restart',
              message: `Host 重启：任务状态已从磁盘恢复（进度 ${job.progress.toFixed(1)}%）`,
            })
          }
        }
        engine.loadActiveFromDisk()
        engine.start()
        bus.emit('host:update', { info: ctx.hostInfo() })
        bus.emit('snapshot', {})
        log.host('Host 已模拟重启（simulated restart）— 队列/任务状态从磁盘恢复')
      })()
    },
  }

  // SelfTest 注入
  const { SelfTestRunner } = await import('./tests/selftest')
  ctx.selfTest = new SelfTestRunner(ctx)

  // 恢复上次退出时仍在进行的任务
  engine.loadActiveFromDisk()
  engine.start()

  return {
    ctx,
    start: async () => {
      discovery.start()
      log.host(`OpenPrintShare Host ${OPS_VERSION} 已启动（REST :${restPort} / Realtime :${wsPort}，data=${dataDir}）`)
      log.host('当前打印后端：MockPrinterBackend（Virtual Printer）— 无需真实打印机即可完整演示')
    },
    dispose: () => {
      engine.dispose()
      discovery.stop()
      void printers.persistNow()
    },
  }
}

/** 供 routes/selftest 复用的类型再导出 */
export type { PrintJob, Printer, TestRun, OpsEvent, DiscoveredHost, PairedDevice, PairingRequest }

export function newRunId(): string {
  return `tr-${randomUUID().slice(0, 8)}`
}
