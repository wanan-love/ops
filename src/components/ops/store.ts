'use client'

import { create } from 'zustand'
import { createOpsClient } from '@/lib/ops/client'
import type { DiscoveredHost, HostInfo, HostSettings, OpsEvent, PairingRequest, PairedDevice, Printer, PrintJob, TestRun } from '@/lib/ops/types'

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
  lastRefreshAt: number
  busy: string | null

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
  refresh: () => Promise<void>
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
  lastRefreshAt: 0,
  busy: null,

  setRestPort: (port) => set({ restPort: port, hostInfo: null, printers: [], jobs: [], events: [], connected: false }),
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

  refresh: async () => {
    const { restPort } = get()
    const client = createOpsClient(restPort)
    try {
      const [info, printersRes, jobsRes, eventsRes, pairing, settingsRes, hostsRes] = await Promise.all([
        client.systemInfo(),
        client.printers('admin'),
        client.jobs({ limit: 200 }),
        client.events(120),
        client.pairingRequests(),
        client.settings(),
        client.discoveryHosts(),
      ])
      set({
        hostInfo: info,
        connected: true,
        printers: printersRes.printers,
        jobs: jobsRes.jobs,
        events: eventsRes.events,
        pairingRequests: pairing.requests,
        settings: settingsRes.settings,
        hosts: hostsRes.hosts,
        lastRefreshAt: Date.now(),
      })
    } catch {
      set({ connected: false })
    }
  },
}))
