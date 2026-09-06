'use client'

import { Github, HardDrive } from 'lucide-react'
import { useOpsStore } from './store'
import { OPS_VERSION } from '@/lib/ops/types'

export function Footer() {
  const hostInfo = useOpsStore((s) => s.hostInfo)
  const socketConnected = useOpsStore((s) => s.socketConnected)
  const restPort = useOpsStore((s) => s.restPort)

  return (
    <footer className="mt-auto border-t bg-muted/30">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 text-xs text-muted-foreground">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-medium">OpenPrintShare v{hostInfo?.version ?? OPS_VERSION}</span>
          <span className="hidden items-center gap-1 sm:flex" title={hostInfo?.dataDir}>
            <HardDrive className="size-3" aria-hidden />
            {hostInfo?.backends?.length ? `后端：${hostInfo.backends.map((b) => b.toUpperCase()).join(' / ')}` : 'PrinterBackend 统一接口'}
          </span>
          <span className="flex items-center gap-1">
            <span className={`size-1.5 rounded-full ${socketConnected ? 'bg-emerald-500' : 'bg-zinc-400'}`} aria-hidden />
            REST :{restPort} / RT :{restPort + 1}
          </span>
        </div>
        <a
          href="https://github.com/wanan-love/ops"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 rounded-sm transition-colors duration-200 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <Github className="size-3.5" aria-hidden />
          wanan-love/ops
        </a>
      </div>
    </footer>
  )
}
