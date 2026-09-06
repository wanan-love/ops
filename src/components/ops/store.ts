'use client'

import { create } from 'zustand'
import { createOpsClient, CONSOLE_AUTH_REQUIRED_EVENT } from '@/lib/ops/client'
import { setConsoleTokenState } from '@/lib/ops/hooks'
import type {
  DiscoveredHost,
  HostInfo,
  HostSettings,
  OpsEvent,
  PairingRequest,
  PairedDevice,
  Printer,
  PrintJob,
  ScanDevice,
  ScanJob,
  TestRun,
} from '@/lib/ops/types'

export const DEFAULT_REST_PORT = 3001

interface OpsState {
  /** 当前连接的 Host REST 端口（网关 XTransformPort） */
  restPort: number
  connected: boolean
  socketConnected: boolean
  hostInfo: HostInfo | null
  settings: HostSettings | null
  printers: Printer[]
  jobs: PrintJob[]
  events: OpsEvent[]
  pairingRequests: PairingRequest[]
  devices: PairedDevice[]
  hosts: DiscoveredHost[]
  testRun: TestRun | null
  scanDevices: ScanDevice[]
  scanJobs: ScanJob[]
  lastRefreshAt: number
  busy: string | null
  /** 控制台鉴权门：true → 渲染解锁界面（Host 已启用访问令牌且本端未持有效令牌） */
  consoleAuthRequired: boolean

  setRestPort: (port: number) => void
  setSocketConnected: (v: boolean) => void
  setConnected: (v: boolean) => void
  applyJob: (job: PrintJob) => void
  applyPrinter: (printer: Printer) => void
  applyEvent: (event: OpsEvent) => void
  applyHostInfo: (info: HostInfo) => void
  applyPairing: (payload: { requests: PairingRequest[]; devices: PairedDevice[] }) => void
  applyTestRun: (run: TestRun) => void
  applyHosts: (hosts: DiscoveredHost[]) => void
  applyScanJob: (job: ScanJob) => void
  refresh: () => Promise<void>
  refreshScan: () => Promise<void>
  scanMdns: () => Promise<ScanDevice[]>
  startScan: (input: { deviceId: string; format?: string; dpi?: number; colorMode?: string; inputSource?: string; duplex?: boolean }) => Promise<ScanJob>
  cancelScanJob: (id: string) => Promise<ScanJob>
  deleteScanJob: (id: string) => Promise<void>
  exportScanPdf: (id: string) => Promise<ScanJob>
  addScanDevice: (input: { baseUrl: string; name?: string }) => Promise<ScanDevice>
  removeScanDevice: (id: string) => Promise<void>
  // 控制台鉴权（P2 安全轮）
  consoleLogin: (token: string) => Promise<boolean>
  consoleLogout: () => void
  consoleEnableAuth: () => Promise<string>
  consoleDisableAuth: () => Promise<void>
  consoleRegenerate: () => Promise<string>
}

export function useOpsClient() {
  const port = useOpsStore((s) => s.restPort)
  return createOpsClient(port)
}

export const useOpsStore = create<OpsState>((set, get) => ({
  restPort: DEFAULT_REST_PORT,
  connected: false,
  socketConnected: false,
  hostInfo: null,
  settings: null,
  printers: [],
  jobs: [],
  events: [],
  pairingRequests: [],
  devices: [],
  hosts: [],
  testRun: null,
  scanDevices: [],
  scanJobs: [],
  lastRefreshAt: 0,
  busy: null,
  consoleAuthRequired: false,

  setRestPort: (port) => set({ restPort: port, hostInfo: null, printers: [], jobs: [], events: [], scanDevices: [], scanJobs: [], connected: false }),
  setSocketConnected: (v) => set({ socketConnected: v }),
  setConnected: (v) => set({ connected: v }),

  applyJob: (job) => {
    const jobs = get().jobs.filter((j) => j.id !== job.id)
    set({ jobs: [job, ...jobs].slice(0, 400) })
  },

  applyPrinter: (printer) => {
    const exists = get().printers.some((p) => p.id === printer.id)
    set({
      printers: exists ? get().printers.map((p) => (p.id === printer.id ? printer : p)) : [...get().printers, printer],
    })
  },

  applyEvent: (event) => {
    if (get().events.some((e) => e.id === event.id)) return
    set({ events: [event, ...get().events].slice(0, 300) })
  },

  applyHostInfo: (info) => set({ hostInfo: info, connected: true }),
  applyPairing: ({ requests, devices }) => set({ pairingRequests: requests, devices }),
  applyTestRun: (run) => set({ testRun: run }),
  applyHosts: (hosts) => set({ hosts }),

  applyScanJob: (job) => {
    const rest = get().scanJobs.filter((j) => j.id !== job.id)
    set({
      scanJobs: [job, ...rest]
        .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))
        .slice(0, 200),
    })
  },

  refresh: async () => {
    const { restPort, testRun } = get()
    const client = createOpsClient(restPort)
    try {
      const [info, printersRes, jobsRes, eventsRes, pairing, settingsRes, hostsRes, scanDevicesRes, scanJobsRes] = await Promise.all([
        client.systemInfo(),
        client.printers('admin'),
        client.jobs({ limit: 200 }),
        client.events(120),
        client.pairingRequests(),
        client.settings(),
        client.discoveryHosts(),
        client.scanDevices().catch(() => ({ devices: [] as ScanDevice[] })),
        client.scanJobs().catch(() => ({ jobs: [] as ScanJob[] })),
      ])
      // WS 掉线期间的自测进度补偿：运行中 → 从 REST 拉取最新 run 状态（避免 UI 冻结在旧进度）
      let mergedRun = testRun
      if (testRun?.status === 'running') {
        try {
          const runs = await client.testRuns()
          mergedRun = runs.runs.find((r) => r.runId === testRun.runId) ?? testRun
        } catch {
          /* 保留现有状态 */
        }
      }
      set({
        hostInfo: info,
        connected: true,
        consoleAuthRequired: false,
        printers: printersRes.printers,
        jobs: jobsRes.jobs,
        events: eventsRes.events,
        pairingRequests: pairing.requests,
        settings: settingsRes.settings,
        hosts: hostsRes.hosts,
        scanDevices: scanDevicesRes.devices,
        scanJobs: scanJobsRes.jobs,
        testRun: mergedRun,
        lastRefreshAt: Date.now(),
      })
    } catch {
      set({ connected: false })
      // 控制台鉴权锁定态：system/info 是公网白名单，仍可拉取 → header 可显示主机名 + 锁徽章
      try {
        const info = await client.systemInfo()
        set({ hostInfo: info })
      } catch {
        /* Host 完全不可达 */
      }
    }
  },

  refreshScan: async () => {
    const { restPort } = get()
    const client = createOpsClient(restPort)
    const [devicesRes, jobsRes] = await Promise.all([
      client.scanDevices().catch(() => ({ devices: [] as ScanDevice[] })),
      client.scanJobs().catch(() => ({ jobs: [] as ScanJob[] })),
    ])
    set({ scanDevices: devicesRes.devices, scanJobs: jobsRes.jobs })
  },

  scanMdns: async () => {
    const { restPort } = get()
    const client = createOpsClient(restPort)
    const { devices } = await client.scanMdns()
    // 合并而非替换：GET /scan/devices 只返回 vscan+manual（mdns 结果后端不持久化），
    // 现有设备全部保留；mdns 结果中 baseUrl 与任一现有设备相同的视为同一台跳过，其余追加
    const existing = get().scanDevices
    const seenBaseUrls = new Set(existing.map((d) => d.baseUrl))
    const fresh = devices.filter((d) => !seenBaseUrls.has(d.baseUrl))
    set({ scanDevices: [...existing, ...fresh] })
    return devices
  },

  startScan: async (input) => {
    const { restPort } = get()
    const client = createOpsClient(restPort)
    const { job } = await client.startScan(input)
    get().applyScanJob(job)
    return job
  },

  cancelScanJob: async (id) => {
    const { restPort } = get()
    const client = createOpsClient(restPort)
    const { job } = await client.cancelScanJob(id)
    get().applyScanJob(job)
    return job
  },

  deleteScanJob: async (id) => {
    const { restPort } = get()
    const client = createOpsClient(restPort)
    await client.deleteScanJob(id)
    set({ scanJobs: get().scanJobs.filter((j) => j.id !== id) })
  },

  exportScanPdf: async (id) => {
    const { restPort } = get()
    const client = createOpsClient(restPort)
    const { job } = await client.exportScanPdf(id)
    get().applyScanJob(job)
    return job
  },

  addScanDevice: async (input) => {
    const { restPort } = get()
    const client = createOpsClient(restPort)
    const { device } = await client.addScanDevice(input)
    const exists = get().scanDevices.some((d) => d.id === device.id)
    set({
      scanDevices: exists
        ? get().scanDevices.map((d) => (d.id === device.id ? device : d))
        : [...get().scanDevices, device],
    })
    return device
  },

  removeScanDevice: async (id) => {
    const { restPort } = get()
    const client = createOpsClient(restPort)
    await client.removeScanDevice(id)
    set({ scanDevices: get().scanDevices.filter((d) => d.id !== id) })
  },

  // ---------------------------------------------------------------- 控制台鉴权（P2 安全轮）

  consoleLogin: async (token) => {
    const { restPort } = get()
    const client = createOpsClient(restPort)
    try {
      await client.consoleAuth(token)
    } catch {
      return false
    }
    setConsoleTokenState(token)
    set({ consoleAuthRequired: false, connected: true })
    await get().refresh()
    return true
  },

  consoleLogout: () => {
    setConsoleTokenState(null)
    const stillEnabled = get().hostInfo?.consoleAuthEnabled === true
    set({
      connected: !stillEnabled,
      consoleAuthRequired: stillEnabled,
      ...(stillEnabled ? { hostInfo: null, printers: [], jobs: [], events: [], scanDevices: [], scanJobs: [], pairingRequests: [], devices: [], hosts: [], settings: null } : {}),
    })
  },

  consoleEnableAuth: async () => {
    const { restPort } = get()
    const client = createOpsClient(restPort)
    const res = await client.consoleEnable()
    setConsoleTokenState(res.token)
    await get().refresh()
    return res.token
  },

  consoleDisableAuth: async () => {
    const { restPort } = get()
    const client = createOpsClient(restPort)
    await client.consoleDisable()
    // 清除本端令牌（已失效；再次启用时总是全新值）
    setConsoleTokenState(null)
    await get().refresh()
  },

  consoleRegenerate: async () => {
    const { restPort } = get()
    const client = createOpsClient(restPort)
    const res = await client.consoleRegenerateToken()
    setConsoleTokenState(res.token)
    await get().refresh()
    return res.token
  },
}))

// 控制台鉴权 401 / WS auth:error → 全局解锁门（client.ts 与 ops-app 的 socket 监听均派发此事件）
if (typeof window !== 'undefined') {
  window.addEventListener(CONSOLE_AUTH_REQUIRED_EVENT, () => {
    const s = useOpsStore.getState()
    if (!s.consoleAuthRequired) useOpsStore.setState({ consoleAuthRequired: true, connected: false })
  })
}
