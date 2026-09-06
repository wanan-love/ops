'use client'

import { Lock, Moon, Printer, Radio, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useOpsStore } from './store'
import { OPS_VERSION } from '@/lib/ops/types'
import { cn } from '@/lib/utils'

export function Header() {
  const { setTheme, resolvedTheme } = useTheme()
  const hostInfo = useOpsStore((s) => s.hostInfo)
  const connected = useOpsStore((s) => s.connected)
  const socketConnected = useOpsStore((s) => s.socketConnected)
  const consoleAuthEnabled = hostInfo?.consoleAuthEnabled === true

  return (
    <header className="border-b">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-primary/85 text-primary-foreground shadow-sm" aria-hidden>
            <Printer className="size-5" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold leading-tight">OpenPrintShare</h1>
            <p className="truncate text-xs text-muted-foreground">
              跨平台局域网共享打印机 · OPS/{hostInfo?.apiVersion ?? 1} · v{hostInfo?.version ?? OPS_VERSION}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 sm:gap-2">
          {consoleAuthEnabled && (
            <div
              className="flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-700 shadow-xs sm:px-2.5 sm:py-1.5 dark:text-amber-400"
              role="status"
              title="管理面已启用访问令牌（REST/WS 需鉴权；设备打印/配对不受影响）"
              aria-label="控制台鉴权已启用"
            >
              <Lock className="size-3.5 shrink-0" aria-hidden />
              <span className="hidden md:inline">控制台鉴权已启用</span>
            </div>
          )}

          <div
            className={cn(
              'flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium shadow-xs',
              connected ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400',
            )}
            role="status"
            aria-live="polite"
          >
            <Radio className={cn('size-3.5', connected && 'animate-pulse')} aria-hidden />
            <span className="hidden sm:inline">{connected ? `已连接 ${hostInfo?.hostName ?? 'Host'}` : '未连接 Host'}</span>
            <span className="sm:hidden">{connected ? '已连接' : '离线'}</span>
            <span
              className={cn('ml-1 size-1.5 rounded-full', socketConnected ? 'bg-emerald-500' : 'bg-zinc-400')}
              title={socketConnected ? '实时通道（WebSocket）已连接' : '实时通道断开，正在轮询'}
              aria-hidden
            />
          </div>

          <button
            onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
              className="flex size-9 items-center justify-center rounded-md border text-muted-foreground transition-colors duration-200 hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-sm:size-11"
              aria-label="切换深色/浅色主题"
            >
              <Sun className="hidden size-4 dark:block" aria-hidden />
              <Moon className="size-4 dark:hidden" aria-hidden />
            </button>
        </div>
      </div>
    </header>
  )
}
