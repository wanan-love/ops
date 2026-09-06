'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { io, type Socket } from 'socket.io-client'
import { wsUrl } from '@/lib/ops/client'
import { useOpsStore } from './store'
import type { HostInfo, OpsEvent, PairingRequest, PairedDevice, Printer, PrintJob, TestRun, DiscoveredHost } from '@/lib/ops/types'
import { OverviewView } from './overview-view'
import { DiscoveryView } from './discovery-view'
import { PrintersView } from './printers-view'
import { PrintView } from './print-view'
import { QueueView } from './queue-view'
import { PairingView } from './pairing-view'
import { DebugView } from './debug-view'
import { EventsView } from './events-view'
import { BackendsView } from './backends-view'
import { Header } from './header'
import { Footer } from './footer'

const TAB_ITEMS = [
  { value: 'overview', label: '概览' },
  { value: 'discovery', label: '发现主机' },
  { value: 'printers', label: '打印机' },
  { value: 'print', label: '打印' },
  { value: 'queue', label: '打印队列' },
  { value: 'pairing', label: '设备配对' },
  { value: 'backends', label: '打印后端' },
  { value: 'debug', label: '调试控制台' },
  { value: 'events', label: '事件日志' },
] as const

export type TabValue = (typeof TAB_ITEMS)[number]['value']

export default function OpsApp() {
  const [tab, setTab] = useState<TabValue>('overview')
  const restPort = useOpsStore((s) => s.restPort)
  const refresh = useOpsStore((s) => s.refresh)
  const socketConnected = useOpsStore((s) => s.socketConnected)
  const socketRef = useRef<Socket | null>(null)

  useEffect(() => {
    void refresh()
  }, [restPort, refresh])

  // 实时层（socket.io，经网关 ?XTransformPort=restPort+1）
  useEffect(() => {
    const socket = io(wsUrl(restPort + 1), {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      timeout: 8000,
    })
    socketRef.current = socket

    const store = useOpsStore.getState()
    socket.on('connect', () => {
      useOpsStore.getState().setSocketConnected(true)
      void useOpsStore.getState().refresh()
    })
    socket.on('disconnect', () => {
      useOpsStore.getState().setSocketConnected(false)
    })
    socket.on('job:update', (job: PrintJob) => store.applyJob(job))
    socket.on('printer:update', (printer: Printer) => store.applyPrinter(printer))
    socket.on('event', (event: OpsEvent) => useOpsStore.getState().applyEvent(event))
    socket.on('host:update', (info: HostInfo) => useOpsStore.getState().applyHostInfo(info))
    socket.on('pairing:update', (payload: { requests: PairingRequest[]; devices: PairedDevice[] }) => useOpsStore.getState().applyPairing(payload))
    socket.on('test:progress', (run: TestRun) => useOpsStore.getState().applyTestRun(run))
    socket.on('discovery:update', (payload: { hosts: DiscoveredHost[] }) => useOpsStore.getState().applyHosts(payload.hosts))
    socket.on('snapshot', () => {
      void useOpsStore.getState().refresh()
    })

    return () => {
      socket.disconnect()
      socketRef.current = null
    }
  }, [restPort])

  // WS 断开时的兜底轮询
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(() => {
    if (!socketConnected) {
      pollRef.current = setInterval(() => {
        void useOpsStore.getState().refresh()
      }, 4000)
    } else if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [socketConnected])

  const goto = useCallback((v: TabValue) => setTab(v), [])

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <Header />
      <nav aria-label="主导航" className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="mx-auto w-full max-w-6xl px-4">
          <div role="tablist" aria-label="功能区域" className="flex gap-1 overflow-x-auto py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {TAB_ITEMS.map((item) => {
              const active = tab === item.value
              return (
                <button
                  key={item.value}
                  role="tab"
                  aria-selected={active}
                  onClick={() => setTab(item.value)}
                  className={
                    'relative flex min-h-11 shrink-0 items-center rounded-md px-3 text-sm font-medium transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:min-h-9 ' +
                    (active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground')
                  }
                >
                  {item.label}
                  <span
                    className={
                      'absolute inset-x-2.5 bottom-0.5 h-0.5 rounded-full bg-primary transition-opacity duration-200 ' +
                      (active ? 'opacity-100' : 'opacity-0')
                    }
                    aria-hidden
                  />
                </button>
              )
            })}
          </div>
        </div>
      </nav>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        <motion.div
          key={tab}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
        >
          {tab === 'overview' && <OverviewView goto={goto} />}
          {tab === 'discovery' && <DiscoveryView />}
          {tab === 'printers' && <PrintersView />}
          {tab === 'print' && <PrintView goto={goto} />}
          {tab === 'queue' && <QueueView />}
          {tab === 'pairing' && <PairingView />}
          {tab === 'backends' && <BackendsView goto={goto} />}
          {tab === 'debug' && <DebugView goto={goto} />}
          {tab === 'events' && <EventsView />}
        </motion.div>
      </main>

      <Footer />
    </div>
  )
}
