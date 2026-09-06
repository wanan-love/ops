import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
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
import { BackendManager } from './backends/index'
import { MockPrinterBackend } from './backends/index'
import { IPPPrinterBackend } from './backends/ipp-backend'
import { CupsPrinterBackend } from './backends/cups'
import { WindowsPrinterBackend } from './backends/windows'
import { BackendJobRunner, BackendStatusSync } from './core/backend-jobs'
import { VirtualIppServer } from './vipp/server'
import { MdnsService } from './discovery/mdns'

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
  /** 统一后端注册表（阶段 2） */
  backends: BackendManager
  /** Virtual IPP Server（OPS_VIPP_ENABLED=0 时为 null） */
  vipp: VirtualIppServer | null
  /** 真实后端任务执行器（backend !== 'mock' 的打印机） */
  runner: BackendJobRunner
  /** 真实后端打印机状态同步（每 5s） */
  statusSync: BackendStatusSync
  /** mDNS 浏览/通告（组播不可用时降级） */
  mdns: MdnsService
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

  // ---------------------------------------------------------------- Virtual IPP Server（:3061）
  const vippEnabled = process.env.OPS_VIPP_ENABLED !== '0'
  const vippPort = Number(process.env.OPS_VIPP_PORT ?? 3061) || 3061
  const vippPpm = Number(process.env.OPS_VIPP_PPM ?? 60) || 60
  const vippDataDir = process.env.OPS_VIPP_DATA_DIR ?? resolve(dataDir, '..', 'virtual-ipp')
  let vipp: VirtualIppServer | null = null
  if (vippEnabled) {
    vipp = new VirtualIppServer({ port: vippPort, dataDir: vippDataDir, defaultPpm: vippPpm, bus })
    try {
      await vipp.start()
    } catch (err) {
      console.error('[ops-host] Virtual IPP Server 启动失败（继续以无 vipp 模式运行）：', err)
      log.record({ type: 'host', topic: 'vipp', message: `Virtual IPP Server 启动失败：${err instanceof Error ? err.message : String(err)}` })
      vipp = null
    }
  }

  // ---------------------------------------------------------------- 统一后端
  const ippBackend = new IPPPrinterBackend({
    baseUri: `ipp://localhost:${vippPort}`,
    registryFile: resolve(dataDir, 'ipp-uris.json'),
  })
  const backends = new BackendManager([
    new MockPrinterBackend(printers, jobs, engine),
    ippBackend,
    new CupsPrinterBackend({ tmpDir: resolve(dataDir, 'tmp') }),
    new WindowsPrinterBackend(),
  ])

  // ---------------------------------------------------------------- 真实后端任务执行器 + 状态同步
  const runner = new BackendJobRunner({ printers, jobs, storage, bus, log, backends })
  const statusSync = new BackendStatusSync({ printers, bus, log, backends })

  // ---------------------------------------------------------------- mDNS（浏览 + Virtual IPP 自通告）
  const mdns = new MdnsService({ bus, log, vipp })

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
    backends,
    vipp,
    runner,
    statusSync,
    mdns,
    restPort,
    wsPort,
    dataDir,
    startedAt,
    hostInfo(): HostInfo {
      const s = settings.get()
      const avail = backends.cachedAvailability()
      return {
        service: 'openprintshare-host',
        hostId: s.hostId,
        hostName: s.hostName,
        version: OPS_VERSION,
        apiVersion: OPS_API_VERSION,
        platform: process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux',
        platformNote: '本演示运行于 Web Host 环境（Bun 运行时）——PlatformAdapter 已按平台解耦',
        backend: backends.primaryBackend(avail ?? []),
        backends: backends.kinds(),
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
        securityMode: s.securityMode,
        restPort,
        wsPort,
        dataDir,
      }
    },
    restartSimulated(): void {
      engine.dispose()
      runner.stop()
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
        runner.reload()
        runner.start()
        bus.emit('host:update', { info: ctx.hostInfo() })
        bus.emit('snapshot', {})
        log.host('Host 已模拟重启（simulated restart）— 队列/任务状态从磁盘恢复')
      })()
    },
  }

  // SelfTest 注入
  const { SelfTestRunner } = await import('./tests/selftest')
  ctx.selfTest = new SelfTestRunner(ctx)

  // 恢复上次退出时仍在进行的任务（mock 引擎 + 真实后端 runner）
  engine.loadActiveFromDisk()
  engine.start()
  runner.reload()
  runner.start()
  statusSync.start()
  mdns.start()

  // 首次后端可用性探测（异步，完成后广播 backend:update）
  void (async () => {
    const avail = await backends.availability(true)
    bus.emit('backend:update', { backends: avail })
    log.host(`打印后端可用性探测完成：${avail.map((a) => `${a.kind}=${a.available ? '可用' : '不可用'}`).join('，')}`)
  })()

  return {
    ctx,
    start: async () => {
      discovery.start()
      log.host(`OpenPrintShare Host ${OPS_VERSION} 已启动（REST :${restPort} / Realtime :${wsPort} / Virtual IPP :${vipp ? vippPort : 'off'}，data=${dataDir}）`)
      log.host(
        vipp
          ? `打印后端：Mock（Virtual Printer）+ IPP 直连（Virtual IPP Server :${vippPort}，真实 RFC 8010 二进制链路）+ CUPS/Windows（代码完备，本环境不可用）`
          : '当前打印后端：MockPrinterBackend（Virtual Printer）— Virtual IPP Server 已禁用（OPS_VIPP_ENABLED=0）',
      )
    },
    dispose: () => {
      engine.dispose()
      discovery.stop()
      runner.dispose()
      statusSync.stop()
      mdns.stop()
      vipp?.dispose()
      void printers.persistNow()
    },
  }
}

/** 供 routes/selftest 复用的类型再导出 */
export type { PrintJob, Printer, TestRun, OpsEvent, DiscoveredHost, PairedDevice, PairingRequest }

export function newRunId(): string {
  return `tr-${randomUUID().slice(0, 8)}`
}
