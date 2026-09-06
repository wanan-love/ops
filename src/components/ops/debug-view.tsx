'use client'

import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  AlertTriangle,
  BatteryCharging,
  CircleCheck,
  CircleDashed,
  Droplet,
  FileWarning,
  FlaskConical,
  Gauge,
  Paperclip,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Trash2,
  TriangleAlert,
  Unplug,
  Zap,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { cn } from '@/lib/utils'
import { useOpsClient, useOpsStore } from './store'
import { InkBars, PrinterStatusBadge, formatDuration, JobStateBadge } from './widgets'
import type { TabValue } from './ops-app'

interface ScenarioMeta {
  id: string
  name: string
  description: string
}

export function DebugView({ goto }: { goto: (v: TabValue) => void }) {
  const printers = useOpsStore((s) => s.printers)
  const jobs = useOpsStore((s) => s.jobs)
  const client = useOpsClient()
  const [printerId, setPrinterId] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [speed, setSpeed] = useState<number | null>(null)
  const [scenarios, setScenarios] = useState<ScenarioMeta[]>([])

  const printer = useMemo(() => printers.find((p) => p.id === printerId) ?? printers[0], [printers, printerId])
  const activeJob = printer?.activeJobId ? jobs.find((j) => j.id === printer.activeJobId) : null
  const currentSpeed = speed ?? printer?.speedOverridePpm ?? printer?.capabilities.ppm ?? 10

  useEffect(() => {
    client
      .testScenarios()
      .then((r) => setScenarios(r.scenarios))
      .catch(() => {})
  }, [client])

  const act = async (key: string, fn: () => Promise<{ message?: string } | void>, successMsg?: string) => {
    setBusy(key)
    try {
      const r = await fn()
      toast.success(successMsg ?? (r as { message?: string })?.message ?? '操作成功')
    } catch (e) {
      toast.error('操作失败', { description: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }

  if (printers.length === 0) {
    return <p className="py-10 text-center text-sm text-muted-foreground">没有可调试的打印机，请先在「打印机」页创建</p>
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Gauge className="size-4 text-muted-foreground" aria-hidden />
            Virtual Printer 模拟控制台
          </CardTitle>
          <div className="flex items-center gap-2">
            <Select value={printer?.id ?? ''} onValueChange={(v) => { setPrinterId(v); setSpeed(null) }}>
              <SelectTrigger className="h-8 w-56" aria-label="选择打印机">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {printers.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        {printer && (
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
              <PrinterStatusBadge status={printer.status} />
              {printer.statusMessage && <span className="text-xs text-muted-foreground">{printer.statusMessage}</span>}
              {activeJob && (
                <span className="ml-auto flex items-center gap-2 text-xs">
                  <JobStateBadge state={activeJob.state} />
                  <span className="font-mono text-muted-foreground">{activeJob.progress.toFixed(0)}%</span>
                </span>
              )}
              <InkBars ink={printer.ink} compact />
            </div>

            <div aria-label="状态模拟按钮组" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <SimButton
                label="Set Online"
                desc="恢复在线（自动续打）"
                icon={<CircleCheck className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden />}
                busy={busy === 'online'}
                disabled={printer.status === 'online' || printer.status === 'busy'}
                onClick={() => act('online', () => client.setCondition(printer.id, 'online'))}
              />
              <SimButton
                label="Set Offline"
                desc="模拟离线"
                icon={<Unplug className="size-4" aria-hidden />}
                busy={busy === 'offline'}
                disabled={printer.status === 'offline'}
                onClick={() => act('offline', () => client.setCondition(printer.id, 'offline'))}
              />
              <SimButton
                label="Paper Out"
                desc="模拟缺纸"
                icon={<Paperclip className="size-4 text-orange-600 dark:text-orange-400" aria-hidden />}
                busy={busy === 'paper-out'}
                disabled={printer.status === 'paper-out'}
                onClick={() => act('paper-out', () => client.setCondition(printer.id, 'paper-out'))}
              />
              <SimButton
                label="Paper Jam"
                desc="模拟卡纸"
                icon={<TriangleAlert className="size-4 text-orange-600 dark:text-orange-400" aria-hidden />}
                busy={busy === 'paper-jam'}
                disabled={printer.status === 'paper-jam'}
                onClick={() => act('paper-jam', () => client.setCondition(printer.id, 'paper-jam'))}
              />
              <SimButton
                label="补纸"
                desc="修复缺纸"
                icon={<Droplet className="size-4" aria-hidden />}
                busy={busy === 'add-paper'}
                disabled={printer.status !== 'paper-out'}
                onClick={() => act('add-paper', () => client.fixPrinter(printer.id, 'add-paper'))}
              />
              <SimButton
                label="清除卡纸"
                desc="修复卡纸"
                icon={<Trash2 className="size-4" aria-hidden />}
                busy={busy === 'clear-jam'}
                disabled={printer.status !== 'paper-jam'}
                onClick={() => act('clear-jam', () => client.fixPrinter(printer.id, 'clear-jam'))}
              />
              <SimButton
                label="Printer Error"
                desc="模拟设备错误"
                icon={<AlertTriangle className="size-4 text-red-600 dark:text-red-400" aria-hidden />}
                busy={busy === 'error'}
                disabled={printer.status === 'error'}
                onClick={() => act('error', () => client.setCondition(printer.id, 'error'))}
              />
              <SimButton
                label="Fail Current Job"
                desc="当前任务 → 失败"
                icon={<FileWarning className="size-4 text-red-600 dark:text-red-400" aria-hidden />}
                busy={busy === 'fail'}
                disabled={!activeJob || !['processing', 'paused'].includes(activeJob.state)}
                onClick={() =>
                  act('fail', () => client.failJob(activeJob!.id, 'Simulated printer error（调试面板注入）'), '当前任务已标记为失败')
                }
              />
              <SimButton
                label="Resume"
                desc="恢复暂停任务"
                icon={<Play className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden />}
                busy={busy === 'resume'}
                disabled={!activeJob || activeJob.state !== 'paused'}
                onClick={() => act('resume', () => client.resumePrinter(printer.id))}
              />
              <SimButton
                label="Cancel Current Job"
                desc="取消当前任务"
                icon={<Pause className="size-4" aria-hidden />}
                busy={busy === 'cancel'}
                disabled={!activeJob || !['pending', 'processing', 'paused'].includes(activeJob.state)}
                onClick={() => act('cancel', () => client.cancelJob(activeJob!.id))}
              />
              <SimButton
                label="加墨"
                desc="墨量 → 100%"
                icon={<BatteryCharging className="size-4" aria-hidden />}
                busy={busy === 'ink'}
                onClick={() => act('ink', () => client.refillInk(printer.id))}
              />
              <SimButton
                label="重置打印机"
                desc="清条件 + 取消任务 + 满墨"
                icon={<RotateCcw className="size-4" aria-hidden />}
                busy={busy === 'reset'}
                onClick={() => act('reset', () => client.resetPrinter(printer.id))}
              />
            </div>

            <div className="space-y-2 rounded-lg border p-3">
              <div className="flex items-center justify-between">
                <Label htmlFor="speed-slider" className="flex items-center gap-2 text-sm">
                  <Zap className="size-3.5 text-muted-foreground" aria-hidden />
                  模拟打印速度
                </Label>
                <span className="font-mono text-sm font-semibold tabular-nums">{currentSpeed} ppm</span>
              </div>
              <Slider
                id="speed-slider"
                min={1}
                max={600}
                step={1}
                value={[currentSpeed]}
                onValueChange={(v) => setSpeed(v[0])}
                onValueCommit={(v) => {
                  void act('speed', () => client.setSpeed(printer.id, v[0]), `速度已设为 ${v[0]} ppm`)
                }}
                aria-label="模拟打印速度（页每分钟）"
              />
              <p className="text-[11px] text-muted-foreground/70">拖动松开后生效（1–600 ppm）· 标称 {printer.capabilities.ppm} ppm</p>
            </div>

            <div className="flex flex-wrap gap-2 border-t pt-3">
              <Button
                variant="outline"
                size="sm"
                disabled={busy === 'restart'}
                onClick={() => act('restart', () => client.debugRestart(), 'Host 已模拟重启（查看队列页验证任务恢复）')}
              >
                <RefreshCw className="size-3.5" aria-hidden />
                模拟 Host 重启
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => act('clear', () => client.clearTestData(), '测试数据已清理')}
                className="h-auto shrink whitespace-normal text-left text-muted-foreground"
              >
                <Trash2 className="size-3.5 shrink-0" aria-hidden />
                清理测试数据（TEST 打印机/任务/报告）
              </Button>
              <Button variant="ghost" size="sm" onClick={() => goto('queue')} className="ml-auto text-muted-foreground">
                <ScrollText className="size-3.5" aria-hidden />
                去队列页观察
              </Button>
            </div>
          </CardContent>
        )}
      </Card>

      <SelfTestPanel scenarios={scenarios} />
    </div>
  )
}

function SimButton({
  label,
  desc,
  icon,
  onClick,
  disabled,
  busy,
}: {
  label: string
  desc: string
  icon: React.ReactNode
  onClick: () => void
  disabled?: boolean
  busy?: boolean
}) {
  return (
    <Button
      variant="outline"
      className="h-auto min-h-16 flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-left whitespace-normal transition-all duration-200 hover:border-primary/40 hover:shadow-xs active:translate-y-0.5"
      onClick={onClick}
      disabled={disabled || busy}
      aria-label={`${label}：${desc}`}
    >
      <span className="flex w-full min-w-0 flex-wrap items-center gap-1.5 text-xs font-semibold">
        <span className="shrink-0 [&>svg]:size-4 [&>svg]:shrink-0">{icon}</span>
        <span className="min-w-0 break-words">{busy ? '执行中…' : label}</span>
      </span>
      <span className="text-[10px] font-normal leading-snug text-muted-foreground">{desc}</span>
    </Button>
  )
}

function SelfTestPanel({ scenarios }: { scenarios: ScenarioMeta[] }) {
  const client = useOpsClient()
  const testRun = useOpsStore((s) => s.testRun)
  const refresh = useOpsStore((s) => s.refresh)
  const [starting, setStarting] = useState(false)

  const running = testRun?.status === 'running'

  const runAll = async () => {
    setStarting(true)
    try {
      await client.runTests()
      toast.info('自动化测试已启动', { description: '10 个场景顺序执行（约 30–40 秒），实时进度见下方' })
    } catch (e) {
      toast.error('启动失败', { description: (e as Error).message })
    } finally {
      setStarting(false)
    }
  }

  const runOne = async (id: string) => {
    try {
      await client.runTests([id])
      toast.info(`场景「${id}」已启动`)
    } catch (e) {
      toast.error('启动失败', { description: (e as Error).message })
    }
  }

  const run = testRun
  const progressPct = run && run.total > 0 ? Math.round((run.results.length / run.total) * 100) : 0

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <FlaskConical className="size-4 text-muted-foreground" aria-hidden />
          Mock Printer 自动化测试（Self-Test）
        </CardTitle>
        <Button size="sm" onClick={runAll} disabled={running || starting}>
          {running || starting ? <RefreshCw className="size-3.5 animate-spin" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
          {running ? `运行中 ${run ? `${run.results.length}/${run.total}` : ''}` : starting ? '启动中…' : '运行全部场景'}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          覆盖：正常打印 / 离线 / 恢复 / 缺纸 / 卡纸 / 打印失败 / 取消任务 / 多任务排队 / 并发任务 / Host 重启。每个场景创建隔离的 TEST 虚拟打印机，
          工件落盘 <code className="rounded bg-muted px-1 font-mono text-[10px]">./data/mock-printer/</code>。
        </p>

        {run && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="font-mono">{run.runId}</span>
              <Badge variant="outline" className={run.status === 'done' ? (run.failed > 0 ? 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400' : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400') : 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400'}>
                {run.status === 'done' ? `${run.passed}/${run.total} 通过` : `运行中 ${run.results.length}/${run.total}`}
              </Badge>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={progressPct} aria-valuemin={0} aria-valuemax={100}>
              <div
                className={cn('h-full bg-primary transition-all duration-300', running && 'ops-shimmer')}
                style={{ width: `${progressPct}%` }}
              />
            </div>

            <ScrollArea className="max-h-96 rounded-md border">
              <ul className="divide-y">
                {run.results.map((r) => (
                  <li key={r.id} className="px-3 py-2.5">
                    <Collapsible>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <CollapsibleTrigger className="flex min-w-0 items-center gap-2 text-left text-sm font-medium hover:underline">
                          <CircleDashed className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                          <span className="truncate">
                            {r.name}
                            <span className="ml-2 font-mono text-[10px] text-muted-foreground/70">{r.id}</span>
                          </span>
                        </CollapsibleTrigger>
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[11px] text-muted-foreground">{formatDuration(r.durationMs)}</span>
                          <Badge
                            variant="outline"
                            className={
                              r.status === 'pass'
                                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                                : r.status === 'fail' || r.status === 'error'
                                  ? 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400'
                                  : 'text-muted-foreground'
                            }
                          >
                            {r.status}
                          </Badge>
                        </div>
                      </div>
                      <CollapsibleContent>
                        <div className="mt-2 space-y-1.5 border-l-2 border-border pl-3">
                          {r.error && <p className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">{r.error}</p>}
                          {r.steps.map((s, i) => (
                            <p key={i} className={`text-xs ${s.ok ? 'text-foreground/80' : 'text-destructive'}`}>
                              <span className="font-mono text-[10px] text-muted-foreground/70">[{s.name}]</span> {s.detail}
                            </p>
                          ))}
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  </li>
                ))}
                {running && (
                  <li className="flex items-center gap-2 px-3 py-2.5 text-sm text-muted-foreground">
                    <RefreshCw className="size-3.5 animate-spin" aria-hidden />
                    剩余场景执行中…
                  </li>
                )}
              </ul>
            </ScrollArea>
          </div>
        )}

        {scenarios.length > 0 && (
          <div className="grid gap-1.5 sm:grid-cols-2">
            {scenarios.map((s) => (
              <button
                key={s.id}
                onClick={() => runOne(s.id)}
                disabled={running}
                className="group flex items-start justify-between gap-2 rounded-md border px-3 py-2.5 text-left text-xs transition-colors duration-200 hover:border-primary/30 hover:bg-accent disabled:opacity-50"
                aria-label={`单独运行场景：${s.name}`}
              >
                <span className="min-w-0">
                  <span className="block font-medium">{s.name}</span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground/80">{s.description}</span>
                </span>
                <Play className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/50 group-hover:text-foreground" aria-hidden />
              </button>
            ))}
          </div>
        )}

        {run?.status === 'done' && (
          <div className="flex flex-wrap items-center gap-2 border-t pt-3">
            <Button variant="ghost" size="sm" onClick={() => void refresh()}>
              <RefreshCw className="size-3.5" aria-hidden />
              刷新数据
            </Button>
            <span className="text-[11px] text-muted-foreground/70">报告已落盘 test-runs/{run.runId}.json · 队列页可查看各场景产生的任务</span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
