'use client'

import { Pause, OctagonX, CircleCheck, CircleDashed, CircleAlert, Loader2, CircleOff, FileText, HelpCircle, MinusCircle, ServerCog } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'
import type { ConsumableInfo, InkLevels, JobState, PrintJob, PrinterStatus, TimelineEntry } from '@/lib/ops/types'
import { BACKEND_LABEL, CAPABILITY_STATE_LABEL, CONSUMABLE_KIND_LABEL, JOB_STATE_LABEL, PRINTER_STATUS_LABEL } from '@/lib/ops/types'

/** 打印后端徽章（Mock / IPP / CUPS / Windows） */
export function BackendBadge({ backend, className }: { backend: string; className?: string }) {
  const map: Record<string, { className: string; label: string }> = {
    mock: { className: 'border-zinc-500/30 bg-zinc-500/10 text-zinc-600 dark:text-zinc-400', label: 'Mock · Virtual' },
    ipp: { className: 'border-teal-500/40 bg-teal-500/10 text-teal-700 dark:text-teal-400', label: 'IPP 直连' },
    cups: { className: 'border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-400', label: 'CUPS' },
    windows: { className: 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-400', label: 'Windows' },
    android: { className: 'border-lime-500/40 bg-lime-500/10 text-lime-700 dark:text-lime-400', label: 'Android' },
    airprint: { className: 'border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-400', label: 'AirPrint' },
  }
  const item = map[backend] ?? { className: 'border-zinc-500/30 bg-zinc-500/10 text-zinc-600', label: backend }
  return (
    <Badge variant="outline" className={cn('gap-1 font-medium', item.className, className)} title={BACKEND_LABEL[backend as keyof typeof BACKEND_LABEL] ?? backend}>
      <ServerCog className="size-3" aria-hidden />
      {item.label}
    </Badge>
  )
}

/** 能力三态徽章（SUPPORTED / UNSUPPORTED / UNKNOWN） */
export function CapabilityStateBadge({ state, className }: { state: string; className?: string }) {
  const map: Record<string, { className: string; icon: React.ReactNode }> = {
    supported: { className: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400', icon: <CircleCheck className="size-3" aria-hidden /> },
    unsupported: { className: 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400', icon: <MinusCircle className="size-3" aria-hidden /> },
    unknown: { className: 'border-zinc-500/30 bg-zinc-500/10 text-zinc-600 dark:text-zinc-400', icon: <HelpCircle className="size-3" aria-hidden /> },
  }
  const item = map[state] ?? map.unknown
  return (
    <Badge variant="outline" className={cn('gap-1 font-mono text-[10px] font-semibold tracking-wide', item.className, className)}>
      {item.icon}
      {CAPABILITY_STATE_LABEL[state as keyof typeof CAPABILITY_STATE_LABEL] ?? state}
    </Badge>
  )
}

/** 耗材面板（真实 IPP/SNMP 读取；UNKNOWN 时由调用方直接隐藏本模块） */
export function ConsumablePanel({ consumables, timestamp }: { consumables: ConsumableInfo[]; timestamp?: string }) {
  if (consumables.length === 0) return null
  return (
    <div className="space-y-1.5">
      {consumables.map((c, i) => (
        <div key={`${c.name}-${i}`} className="flex items-center gap-2">
          <span className="w-24 truncate text-[11px] text-muted-foreground" title={`${c.name}（${CONSUMABLE_KIND_LABEL[c.kind]}）`}>
            {c.name}
          </span>
          {c.levelPct !== null && c.levelPct >= 0 ? (
            <>
              <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden>
                <div
                  className={cn('h-full rounded-full transition-all', c.levelPct <= 15 ? 'bg-orange-500' : c.levelPct <= 30 ? 'bg-amber-500' : 'bg-emerald-500')}
                  style={{ width: `${Math.min(100, Math.max(0, c.levelPct))}%` }}
                />
              </div>
              <span className="w-10 text-right font-mono text-[11px] tabular-nums text-muted-foreground">{c.levelPct}%</span>
            </>
          ) : (
            <span className="flex-1 text-[11px] text-muted-foreground/60">剩余量未知（设备未上报数值）</span>
          )}
        </div>
      ))}
      {timestamp && <p className="text-[10px] text-muted-foreground/60">读取时间 {formatTime(timestamp)} · 来源 {consumables[0]?.source ?? 'UNKNOWN'}</p>}
    </div>
  )
}

/** 打印机状态徽标 */
export function PrinterStatusBadge({ status, className }: { status: PrinterStatus; className?: string }) {
  const map: Record<PrinterStatus, { className: string; dot: string; pulse?: boolean }> = {
    online: { className: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400', dot: 'bg-emerald-500' },
    busy: { className: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400', dot: 'bg-amber-500', pulse: true },
    offline: { className: 'border-zinc-500/30 bg-zinc-500/10 text-zinc-600 dark:text-zinc-400', dot: 'bg-zinc-400' },
    'paper-out': { className: 'border-orange-500/40 bg-orange-500/10 text-orange-700 dark:text-orange-400', dot: 'bg-orange-500' },
    'paper-jam': { className: 'border-orange-600/40 bg-orange-600/10 text-orange-700 dark:text-orange-400', dot: 'bg-orange-600' },
    error: { className: 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400', dot: 'bg-red-500' },
  }
  const item = map[status]
  return (
    <Badge variant="outline" className={cn('gap-1.5 font-medium shadow-xs', item.className, className)}>
      <span className={cn('relative size-1.5 rounded-full', item.dot, item.pulse && 'ops-dot-pulse')} aria-hidden />
      {PRINTER_STATUS_LABEL[status]}
    </Badge>
  )
}

/** 任务状态徽标 */
export function JobStateBadge({ state, className }: { state: JobState; className?: string }) {
  const map: Record<JobState, string> = {
    pending: 'border-zinc-500/30 bg-zinc-500/10 text-zinc-600 dark:text-zinc-400',
    processing: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400',
    paused: 'border-orange-500/40 bg-orange-500/10 text-orange-700 dark:text-orange-400',
    completed: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
    failed: 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400',
    cancelled: 'border-zinc-500/30 bg-zinc-500/10 text-zinc-500 dark:text-zinc-500',
  }
  const icon: Record<JobState, React.ReactNode> = {
    pending: <CircleDashed className="size-3" aria-hidden />,
    processing: <Loader2 className="size-3 animate-spin" aria-hidden />,
    paused: <Pause className="size-3" aria-hidden />,
    completed: <CircleCheck className="size-3" aria-hidden />,
    failed: <CircleAlert className="size-3" aria-hidden />,
    cancelled: <OctagonX className="size-3" aria-hidden />,
  }
  return (
    <Badge variant="outline" className={cn('gap-1 font-medium', map[state], className)}>
      {icon[state]}
      {JOB_STATE_LABEL[state]}
    </Badge>
  )
}

/** CMYK 墨量条 */
export function InkBars({ ink, compact = false }: { ink: InkLevels; compact?: boolean }) {
  const bars: Array<{ label: string; value: number; color: string }> = [
    { label: 'C', value: ink.cyan, color: 'bg-cyan-500' },
    { label: 'M', value: ink.magenta, color: 'bg-fuchsia-500' },
    { label: 'Y', value: ink.yellow, color: 'bg-yellow-400' },
    { label: 'K', value: ink.black, color: 'bg-zinc-700 dark:bg-zinc-300' },
  ]
  const low = Math.min(ink.cyan, ink.magenta, ink.yellow, ink.black) <= 15
  return (
    <div className={cn('flex items-center gap-2', compact ? 'gap-1.5' : 'gap-2.5')}>
      {bars.map((bar) => (
        <div key={bar.label} className="flex items-center gap-1" title={`${bar.label} 墨量 ${bar.value.toFixed(0)}%`}>
          <span className="text-[10px] font-mono text-muted-foreground">{bar.label}</span>
          <div className="h-1.5 w-8 overflow-hidden rounded-full bg-muted" aria-hidden>
            <div className={cn('h-full rounded-full transition-all', bar.color)} style={{ width: `${Math.max(0, Math.min(100, bar.value))}%` }} />
          </div>
        </div>
      ))}
      {low && (
        <span className="text-[10px] font-medium text-orange-600 dark:text-orange-400" title="低墨预警">
          LOW
        </span>
      )}
    </div>
  )
}

/** 任务进度单元格（含百分比文字） */
export function JobProgress({ job }: { job: PrintJob }) {
  if (job.state === 'completed') return <Progress value={100} className="h-2 [&>div]:bg-emerald-500" aria-label="进度 100%" />
  if (job.state === 'pending') return <div className="text-xs text-muted-foreground">— 等待开始 —</div>
  if (job.state === 'paused') return <Progress value={job.progress} className="h-2 [&>div]:bg-orange-500" aria-label={`暂停于 ${job.progress}%`} />
  if (job.state === 'failed') return <div className="text-xs text-red-600 dark:text-red-400 truncate" title={job.error ?? ''}>{job.error ?? '失败'}</div>
  if (job.state === 'cancelled') return <div className="text-xs text-muted-foreground">已取消</div>
  return (
    <div className="flex items-center gap-2">
      <Progress value={job.progress} className="ops-shimmer-progress h-2 [&>div]:bg-amber-500" aria-label={`进度 ${job.progress}%`} />
      <span className="w-9 text-right font-mono text-[11px] tabular-nums text-muted-foreground">{job.progress.toFixed(0)}%</span>
    </div>
  )
}

/** 文件图标 + 名称 */
export function FileLabel({ name, className }: { name: string; className?: string }) {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
      <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="truncate">{name}</span>
    </span>
  )
}

/** 时间线（任务详情 / 调试面板通用） */
export function TimelineList({ timeline }: { timeline: TimelineEntry[] }) {
  if (timeline.length === 0) return <p className="text-sm text-muted-foreground">暂无记录</p>
  const dotColor: Record<TimelineEntry['type'], string> = {
    state: 'bg-emerald-500',
    progress: 'bg-amber-500',
    condition: 'bg-orange-500',
    printer: 'bg-fuchsia-500',
    system: 'bg-zinc-400 dark:bg-zinc-500',
  }
  const typeColor: Record<TimelineEntry['type'], string> = {
    state: 'text-emerald-600 dark:text-emerald-400',
    progress: 'text-amber-600 dark:text-amber-400',
    condition: 'text-orange-600 dark:text-orange-400',
    printer: 'text-fuchsia-600 dark:text-fuchsia-400',
    system: 'text-zinc-500 dark:text-zinc-400',
  }
  return (
    <ol className="relative space-y-4 border-l border-border/70 pl-5">
      {[...timeline].reverse().map((entry, i) => {
        const milestone = entry.type === 'progress' && entry.progress !== undefined && entry.progress > 0 && entry.progress % 25 === 0
        return (
          <li key={`${entry.at}-${i}`} className="relative">
            <span
              className={cn(
                'absolute top-0.5 rounded-full',
                milestone
                  ? '-left-[25px] size-2.5 ring-[3px] ring-background shadow-[0_0_0_5px_rgb(245_158_11_/_0.14)]'
                  : '-left-[24px] size-2 ring-[3px] ring-background',
                dotColor[entry.type],
              )}
              aria-hidden
            />
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{entry.at.slice(11, 23)}</span>
              <span className={cn('text-[10px] font-semibold uppercase tracking-wide', typeColor[entry.type])}>{entry.type}</span>
              {entry.to && (
                <span className="text-xs font-medium">
                  {entry.from ? `${JOB_STATE_LABEL[entry.from]} → ` : ''}
                  {JOB_STATE_LABEL[entry.to]}
                </span>
              )}
              {entry.progress !== undefined && (
                <span
                  className={cn(
                    'rounded font-mono text-xs font-medium',
                    milestone ? 'bg-amber-500/15 px-1.5 text-amber-700 dark:text-amber-300' : 'text-amber-600 dark:text-amber-400',
                  )}
                >
                  {entry.progress}%
                </span>
              )}
            </div>
            {entry.message && <p className="mt-0.5 text-xs text-foreground/80">{entry.message}</p>}
          </li>
        )
      })}
    </ol>
  )
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`
}

export function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false })
  } catch {
    return iso.slice(11, 19)
  }
}

/** 空状态 */
export function EmptyState({ icon, title, hint }: { icon?: React.ReactNode; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2.5 rounded-lg border border-dashed bg-muted/20 p-8 text-center">
      <div className="flex size-11 items-center justify-center rounded-full border bg-muted/50 text-muted-foreground" aria-hidden>
        {icon ?? <CircleOff className="size-5" />}
      </div>
      <p className="text-sm font-medium text-muted-foreground">{title}</p>
      {hint && <p className="max-w-sm text-xs leading-relaxed text-muted-foreground/70">{hint}</p>}
    </div>
  )
}
