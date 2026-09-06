'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { io, type Socket } from 'socket.io-client'
import { FileUp, FlaskConical, History, KeyRound, LayoutDashboard, Printer, Radar, ScanLine, ScrollText, ServerCog } from 'lucide-react'
import { wsUrl } from '@/lib/ops/client'
import { getConsoleToken } from '@/lib/ops/device'
import { useConsoleToken } from '@/lib/ops/hooks'
import { useOpsStore } from './store'
import type { HostInfo, OpsEvent, PairingRequest, PairedDevice, Printer as PrinterRef, PrintJob, ScanJob, TestRun, DiscoveredHost } from '@/lib/ops/types'
import { OverviewView } from './overview-view'
import { DiscoveryView } from './discovery-view'
import { PrintersView } from './printers-view'
import { PrintView } from './print-view'
import { QueueView } from './queue-view'
import { ScanView } from './scan-view'
import { PairingView } from './pairing-view'
import { DebugView } from './debug-view'
import { EventsView } from './events-view'
import { BackendsView } from './backends-view'
import { ConsoleAuthGate } from './console-auth-gate'
import { Header } from './header'
import { Footer } from './footer'

const TAB_ITEMS = [
  { value: 'overview', label: '概览', icon: LayoutDashboard },
  { value: 'discovery', label: '发现主机', icon: Radar },
  { value: 'printers', label: '打印机', icon: Printer },
  { value: 'print', label: '打印', icon: FileUp },
  { value: 'queue', label: '打印队列', icon: History },
  { value: 'scan', label: '扫描', icon: ScanLine },
  { value: 'pairing', label: '设备配对', icon: KeyRound },
  { value: 'backends', label: '打印后端', icon: ServerCog },
  { value: 'events', label: '事件日志', icon: ScrollText },
  { value: 'debug', label: '调试 · 开发测试', icon: FlaskConical },
] as const

export type TabValue = (typeof TAB_ITEMS)[number]['value']

export default function OpsApp() {
  const [tab, setTab] = useState<TabValue>('overview')
  const restPort = useOpsStore((s) => s.restPort)
  const refresh = useOpsStore((s) => s.refresh)
  const socketConnected = useOpsStore((s) => s.socketConnected)
  const consoleAuthRequired = useOpsStore((s) => s.consoleAuthRequired)
  const consoleToken = useConsoleToken()
  const socketRef = useRef<Socket | null>(null)

  useEffect(() => {
    void refresh()
  }, [restPort, refresh])

  // 实时层（socket.io，经网关 ?XTransformPort=restPort+1）
  // 令牌变更（登录/重生成/退出）→ 重建连接，携带最新 console token 握手
  useEffect(() => {
    const token = getConsoleToken()
    const socket = io(wsUrl(restPort + 1), {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      timeout: 8000,
      auth: token ? { token } : undefined,
    })
    socketRef.current = socket

    const store = useOpsStore.getState()
    // 握手被鉴权拒绝的标记：与「服务端主动断开」（enable 时 disconnectSockets）区分——
    // socket.io 对 io server disconnect 不自动重连，需要手动 reconnect；但被拒后盲重连会无限循环，交给解锁门处理
    let rejectedByAuth = false
    socket.on('connect', () => {
      rejectedByAuth = false
      useOpsStore.getState().setSocketConnected(true)
      void useOpsStore.getState().refresh()
    })
    socket.on('disconnect', (reason: string) => {
      useOpsStore.getState().setSocketConnected(false)
      if (reason === 'io server disconnect' && !rejectedByAuth) {
        // 鉴权启用/重生成时服务端主动断开存量连接：带当前令牌手动重连（auth 需热更新，创建时的值已固化）
        const t = getConsoleToken()
        socket.auth = t ? { token: t } : undefined
        setTimeout(() => {
          if (!socket.connected) socket.connect()
        }, 1000)
      }
    })
    // 控制台鉴权拒绝（握手令牌无效）→ 全局解锁门
    // 已持有令牌时忽略（WS 与令牌更新存在竞态，有效性以 REST 401 为准）
    socket.on('auth:error', (data: { code?: string }) => {
      if (data?.code === 'console_auth_required') {
        rejectedByAuth = true
        if (!getConsoleToken()) window.dispatchEvent(new CustomEvent('ops:console-auth-required'))
      }
    })
    socket.on('job:update', (job: PrintJob) => store.applyJob(job))
    socket.on('printer:update', (printer: PrinterRef) => store.applyPrinter(printer))
    socket.on('event', (event: OpsEvent) => useOpsStore.getState().applyEvent(event))
    socket.on('host:update', (info: HostInfo) => useOpsStore.getState().applyHostInfo(info))
    socket.on('pairing:update', (payload: { requests: PairingRequest[]; devices: PairedDevice[] }) => useOpsStore.getState().applyPairing(payload))
    socket.on('test:progress', (run: TestRun) => useOpsStore.getState().applyTestRun(run))
    socket.on('discovery:update', (payload: { hosts: DiscoveredHost[] }) => useOpsStore.getState().applyHosts(payload.hosts))
    socket.on('scan:update', (job: ScanJob) => useOpsStore.getState().applyScanJob(job))
    socket.on('snapshot', () => {
      void useOpsStore.getState().refresh()
    })

    return () => {
      socket.disconnect()
      socketRef.current = null
    }
  }, [restPort, consoleToken])

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

  // 导航横向滚动渐变指示：告知两侧还有未显示的 tab（避免"被截断"观感）
  const tablistRef = useRef<HTMLDivElement>(null)
  const [navFade, setNavFade] = useState({ left: false, right: false })
  useEffect(() => {
    const el = tablistRef.current
    if (!el) return
    const update = () => {
      const canScroll = el.scrollWidth - el.clientWidth > 4
      setNavFade({ left: canScroll && el.scrollLeft > 4, right: canScroll && el.scrollLeft + el.clientWidth < el.scrollWidth - 4 })
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
    }
  }, [])

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <Header />
      <nav aria-label="主导航" className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="relative mx-auto w-full max-w-6xl px-4">
          <div
            ref={tablistRef}
            role="tablist"
            aria-label="功能区域"
            className="flex gap-1 overflow-x-auto py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {TAB_ITEMS.map((item) => {
              const active = tab === item.value
              return (
                <button
                  key={item.value}
                  role="tab"
                  aria-selected={active}
                  onClick={() => setTab(item.value)}
                  className={
                    'relative flex min-h-11 shrink-0 items-center whitespace-nowrap gap-1.5 rounded-md px-3 text-sm font-medium transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:min-h-9 ' +
                    (active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground')
                  }
                >
                  <item.icon className="size-3.5 shrink-0" aria-hidden />
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
          <div
            aria-hidden
            className={'pointer-events-none absolute inset-y-0 left-0 w-10 bg-gradient-to-r from-background to-transparent transition-opacity duration-200 ' + (navFade.left ? 'opacity-100' : 'opacity-0')}
          />
          <div
            aria-hidden
            className={'pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-background to-transparent transition-opacity duration-200 ' + (navFade.right ? 'opacity-100' : 'opacity-0')}
          />
        </div>
      </nav>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        {consoleAuthRequired ? (
          <ConsoleAuthGate />
        ) : (
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
            {tab === 'scan' && <ScanView />}
            {tab === 'pairing' && <PairingView />}
            {tab === 'backends' && <BackendsView goto={goto} />}
            {tab === 'debug' && <DebugView goto={goto} />}
            {tab === 'events' && <EventsView />}
          </motion.div>
        )}
      </main>

      <Footer />
    </div>
  )
}
