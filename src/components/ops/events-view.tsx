'use client'

import { useMemo, useState } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { useOpsStore } from './store'
import { FadingScrollArea, formatTime } from './widgets'
import type { OpsEvent } from '@/lib/ops/types'
import { ScrollText } from 'lucide-react'

const TYPE_COLOR: Record<OpsEvent['type'], string> = {
  job: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  printer: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  pairing: 'bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400',
  host: 'bg-sky-500/10 text-sky-700 dark:text-sky-400',
  test: 'bg-orange-500/10 text-orange-600 dark:text-orange-400',
  security: 'bg-red-500/10 text-red-600 dark:text-red-400',
  discovery: 'bg-teal-500/10 text-teal-600 dark:text-teal-400',
}

export function EventsView() {
  const events = useOpsStore((s) => s.events)
  const [typeFilter, setTypeFilter] = useState('all')

  const filtered = useMemo(() => (typeFilter === 'all' ? events : events.filter((e) => e.type === typeFilter)), [events, typeFilter])

  const typeCount = useMemo(() => {
    const c: Record<string, number> = {}
    for (const e of events) c[e.type] = (c[e.type] ?? 0) + 1
    return c
  }, [events])

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <ScrollText className="size-4 text-muted-foreground" aria-hidden />
          事件日志（全局状态变化记录 · events.jsonl）
        </CardTitle>
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="h-8 w-32" aria-label="按类型筛选事件">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部（{events.length}）</SelectItem>
            <SelectItem value="job">任务</SelectItem>
            <SelectItem value="printer">打印机</SelectItem>
            <SelectItem value="pairing">配对</SelectItem>
            <SelectItem value="host">Host</SelectItem>
            <SelectItem value="test">测试</SelectItem>
            <SelectItem value="security">安全</SelectItem>
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent>
        <FadingScrollArea className="max-h-[36rem] rounded-md border">
          {filtered.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">暂无事件记录</p>
          ) : (
            <ul className="divide-y">
              {filtered.map((e) => (
                <li key={e.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2 font-mono text-xs transition-colors duration-150 hover:bg-accent/40">
                  <span className="shrink-0 tabular-nums text-muted-foreground">{formatTime(e.at)}</span>
                  <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide', TYPE_COLOR[e.type])}>{e.type}</span>
                  <span className="min-w-0 break-all text-foreground/90">{e.message}</span>
                  {e.data?.jobId && <span className="shrink-0 text-[10px] text-muted-foreground/60">{String(e.data.jobId).slice(0, 12)}</span>}
                </li>
              ))}
            </ul>
          )}
        </FadingScrollArea>
        <p className="mt-2 text-[11px] text-muted-foreground/70">
          {Object.entries(typeCount)
            .map(([k, v]) => `${k}:${v}`)
            .join(' · ')}
          （实时推送 + 落盘持久化，Host 重启后可回放）
        </p>
      </CardContent>
    </Card>
  )
}
