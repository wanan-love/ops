'use client'

import { Activity, ArrowRight, CircleCheck, FileText, HardDrive, Printer, Rocket, Wifi } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useOpsClient, useOpsStore } from './store'
import { EmptyState, JobProgress, JobStateBadge, formatBytes, formatTime } from './widgets'
import { useEffect, useState } from 'react'
import type { SystemStats } from '@/lib/ops/types'
import type { TabValue } from './ops-app'

export function OverviewView({ goto }: { goto: (v: TabValue) => void }) {
  const hostInfo = useOpsStore((s) => s.hostInfo)
  const printers = useOpsStore((s) => s.printers)
  const jobs = useOpsStore((s) => s.jobs)
  const events = useOpsStore((s) => s.events)
  const client = useOpsClient()
  const [stats, setStats] = useState<SystemStats | null>(null)
  const [uptime, setUptime] = useState(0)

  useEffect(() => {
    let alive = true
    const load = () => client.systemStats().then((s) => alive && setStats(s)).catch(() => {})
    void load()
    const t = setInterval(load, 8000)
    const u = setInterval(() => alive && setUptime(Math.floor(Date.now() / 1000)), 1000)
    return () => {
      alive = false
      clearInterval(t)
      clearInterval(u)
    }
  }, [client])

  const activeJobs = jobs.filter((j) => ['pending', 'processing', 'paused'].includes(j.state)).slice(0, 8)
  const sharedCount = printers.filter((p) => p.shared).length
  const onlineCount = printers.filter((p) => p.status === 'online' || p.status === 'busy').length
  const completedCount = stats?.jobs.completed ?? jobs.filter((j) => j.state === 'completed').length

  const cards = [
    { label: '共享打印机', value: `${sharedCount}/${printers.length}`, hint: `${onlineCount} 台在线`, icon: Printer },
    { label: '进行中任务', value: String(activeJobs.length), hint: '排队 / 打印 / 暂停', icon: Activity },
    { label: '已完成任务', value: String(completedCount), hint: '全部历史任务', icon: CircleCheck },
    {
      label: '数据目录',
      value: stats ? (
        formatBytes(stats.storage.bytes)
      ) : (
        <span className="mt-1 inline-block h-7 w-20 animate-pulse rounded-md bg-muted" aria-label="加载中" />
      ),
      hint: stats ? `${stats.storage.jobs} 个任务工件` : '加载中',
      icon: HardDrive,
    },
  ]

  return (
    <div className="space-y-6">
      <section aria-label="核心指标" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {cards.map((c) => (
          <Card key={c.label} className="min-w-0 gap-2 py-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md">
            <CardContent className="flex items-start justify-between gap-2 px-4">
              <div className="min-w-0">
                <p className="text-xs font-medium text-muted-foreground">{c.label}</p>
                <p className="mt-1 truncate text-2xl font-semibold tabular-nums">{c.value}</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground/70">{c.hint}</p>
              </div>
              <div className="rounded-lg bg-primary/10 p-2 text-primary" aria-hidden>
                <c.icon className="size-4" />
              </div>
            </CardContent>
          </Card>
        ))}
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="min-w-0 lg:col-span-1">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Wifi className="size-4 text-muted-foreground" aria-hidden />
              Host 信息
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="主机名" value={hostInfo?.hostName ?? '—'} />
            <Row label="Host ID" value={hostInfo ? hostInfo.hostId.slice(0, 13) + '…' : '—'} mono />
            <Row label="版本" value={`v${hostInfo?.version ?? '—'} · OPS/${hostInfo?.apiVersion ?? '—'}`} />
            <Row label="平台" value={`${hostInfo?.platform ?? '—'}（Web Host 演示环境）`} />
            <Row label="运行时长" value={hostInfo ? formatUptime(hostInfo.uptimeSec + uptime) : '—'} mono />
            <Row label="安全模式" value={hostInfo?.securityMode === 'pairing' ? '配对（需令牌）' : '开放（局域网信任）'} />
            <Row label="后端" value="MockPrinterBackend（Virtual Printer）" />
          </CardContent>
        </Card>

        <Card className="min-w-0 lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Activity className="size-4 text-muted-foreground" aria-hidden />
              进行中的打印任务
            </CardTitle>
            <Button variant="ghost" size="sm" onClick={() => goto('queue')}>
              查看队列 <ArrowRight className="size-3.5" aria-hidden />
            </Button>
          </CardHeader>
          <CardContent>
            {activeJobs.length === 0 ? (
              <EmptyState icon={<FileText className="size-6" aria-hidden />} title="当前没有进行中的任务" hint="在「打印」页提交 PDF，或在「调试控制台」运行自动化测试" />
            ) : (
              <ScrollArea className="max-h-72 pr-3">
                <ul className="space-y-3">
                  {activeJobs.map((job) => {
                    const printer = printers.find((p) => p.id === job.printerId)
                    return (
                      <li key={job.id} className="rounded-lg border p-3 transition-colors duration-200 hover:border-primary/30">
                        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                          <span className="truncate text-sm font-medium">{job.fileName}</span>
                          <JobStateBadge state={job.state} />
                        </div>
                        <JobProgress job={job} />
                        <p className="mt-1.5 text-[11px] text-muted-foreground">
                          {printer?.name ?? job.printerId} · 来自 {job.source.deviceName} · {job.pageCount} 页 × {job.options.copies} 份
                        </p>
                      </li>
                    )
                  })}
                </ul>
              </ScrollArea>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="min-w-0 lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">最近事件</CardTitle>
          </CardHeader>
          <CardContent>
            <ScrollArea className="max-h-64 pr-3">
              {events.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">暂无事件</p>
              ) : (
                <ul className="space-y-1.5 font-mono text-xs">
                  {events.slice(0, 30).map((e) => (
                    <li key={e.id} className="flex gap-2">
                      <span className="shrink-0 tabular-nums text-muted-foreground">{formatTime(e.at)}</span>
                      <span className="shrink-0 font-medium text-muted-foreground/80">[{e.type}]</span>
                      <span className="text-foreground/90">{e.message}</span>
                    </li>
                  ))}
                </ul>
              )}
            </ScrollArea>
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Rocket className="size-4 text-muted-foreground" aria-hidden />
              快速开始
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Button variant="outline" className="w-full justify-start transition-colors duration-200 hover:border-primary/40" onClick={() => goto('discovery')}>
              1. 发现局域网 Host
            </Button>
            <Button variant="outline" className="w-full justify-start transition-colors duration-200 hover:border-primary/40" onClick={() => goto('print')}>
              2. 提交 PDF 打印任务
            </Button>
            <Button variant="outline" className="w-full justify-start transition-colors duration-200 hover:border-primary/40" onClick={() => goto('debug')}>
              3. 调试控制台 / 自动化测试
            </Button>
            <p className="pt-1 text-[11px] leading-relaxed text-muted-foreground/70">
              当前为 Virtual Printer（MockPrinterBackend）演示环境，无需真实打印机即可完整体验：发现 → 打印 → 队列 → 状态模拟 → 测试报告。
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/60 pb-1.5 last:border-0 last:pb-0">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className={`truncate text-right text-xs font-medium ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  )
}

function formatUptime(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}
