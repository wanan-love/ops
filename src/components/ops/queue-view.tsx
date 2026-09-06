'use client'

import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Download, FileText, History, ListFilter, RotateCcw, Sheet, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet as SheetUI, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { useOpsClient, useOpsStore } from './store'
import { EmptyState, FadingScrollArea, FileLabel, JobProgress, JobStateBadge, TimelineList, formatBytes, formatDuration, formatTime } from './widgets'
import { loadDevice } from '@/lib/ops/device'
import type { PrintJob } from '@/lib/ops/types'

export function QueueView() {
  const jobs = useOpsStore((s) => s.jobs)
  const printers = useOpsStore((s) => s.printers)
  const client = useOpsClient()
  const [stateFilter, setStateFilter] = useState<string>('all')
  const [printerFilter, setPrinterFilter] = useState<string>('all')
  const [onlyMine, setOnlyMine] = useState(false)
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)

  const myDeviceId = useMemo(() => (typeof window !== 'undefined' ? loadDevice().deviceId : ''), [])

  const filtered = useMemo(() => {
    return jobs.filter((j) => {
      if (stateFilter !== 'all' && j.state !== stateFilter) return false
      if (printerFilter !== 'all' && j.printerId !== printerFilter) return false
      if (onlyMine && j.source.deviceId !== myDeviceId) return false
      return true
    })
  }, [jobs, stateFilter, printerFilter, onlyMine, myDeviceId])

  const counts = useMemo(() => {
    const c: Record<string, number> = { pending: 0, processing: 0, paused: 0, completed: 0, failed: 0, cancelled: 0 }
    for (const j of jobs) c[j.state] = (c[j.state] ?? 0) + 1
    return c
  }, [jobs])

  const cancel = async (job: PrintJob) => {
    try {
      const r = await client.cancelJob(job.id)
      toast.success('任务已取消', { description: r.message })
    } catch (e) {
      toast.error('取消失败', { description: (e as Error).message })
    }
  }

  const retry = async (job: PrintJob) => {
    try {
      const r = await client.retryJob(job.id)
      toast.success('已重新排队', { description: r.message })
    } catch (e) {
      toast.error('重试失败', { description: (e as Error).message })
    }
  }

  const selectedJob = filtered.find((j) => j.id === selectedJobId) ?? jobs.find((j) => j.id === selectedJobId) ?? null

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <History className="size-4 text-muted-foreground" aria-hidden />
            打印队列（实时）
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="secondary">排队 {counts.pending ?? 0}</Badge>
            <Badge variant="secondary" className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400">
              打印 {counts.processing ?? 0}
            </Badge>
            <Badge variant="secondary" className="border-orange-500/40 bg-orange-500/10 text-orange-700 dark:text-orange-400">暂停 {counts.paused ?? 0}</Badge>
            <Badge variant="secondary" className="border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
              完成 {counts.completed ?? 0}
            </Badge>
            <Badge variant="secondary" className="border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400">失败 {counts.failed ?? 0}</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <ListFilter className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <Select value={stateFilter} onValueChange={setStateFilter}>
                <SelectTrigger className="h-8 w-28 sm:w-32" aria-label="按状态筛选">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部状态</SelectItem>
                  <SelectItem value="pending">排队中</SelectItem>
                  <SelectItem value="processing">打印中</SelectItem>
                  <SelectItem value="paused">已暂停</SelectItem>
                  <SelectItem value="completed">已完成</SelectItem>
                  <SelectItem value="failed">失败</SelectItem>
                  <SelectItem value="cancelled">已取消</SelectItem>
                </SelectContent>
              </Select>
              <Select value={printerFilter} onValueChange={setPrinterFilter}>
                <SelectTrigger className="h-8 w-40" aria-label="按打印机筛选">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部打印机</SelectItem>
                  {printers.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground" aria-label="只看本设备提交的任务">
              <Switch checked={onlyMine} onCheckedChange={setOnlyMine} />
              只看本设备
            </label>
            <span className="ml-auto text-xs text-muted-foreground/70">{filtered.length} 条记录 · WebSocket 实时更新</span>
          </div>

          {/* ≥md：表格布局（列宽随断点收紧，确保 768px 容器内完整可见，无需横向滚动） */}
          <FadingScrollArea className="max-h-[32rem] rounded-md border" wrapperClassName="hidden md:block">
            <Table className="w-full table-fixed min-w-0 [&_th]:h-11 [&_th]:text-xs [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wide [&_td]:py-3">
              <TableHeader className="sticky top-0 z-10 bg-card/95 backdrop-blur">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-28 lg:w-36">任务</TableHead>
                  <TableHead className="min-w-0">文档 / 来源</TableHead>
                  <TableHead className="w-24 lg:w-36">打印机</TableHead>
                  <TableHead className="w-24 lg:w-28">状态</TableHead>
                  <TableHead className="w-36 lg:w-52">进度</TableHead>
                  <TableHead className="w-16 text-right lg:w-24">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                      没有匹配的任务
                    </TableCell>
                  </TableRow>
                )}
                {filtered.map((job, i) => {
                  const printer = printers.find((p) => p.id === job.printerId)
                  const canCancel = ['pending', 'processing', 'paused'].includes(job.state)
                  const canRetry = ['failed', 'cancelled'].includes(job.state)
                  return (
                    <TableRow
                      key={job.id}
                      className={cn('h-14 cursor-pointer hover:bg-primary/5', i % 2 === 1 && 'bg-muted/25')}
                      onClick={() => setSelectedJobId(job.id)}
                      aria-label={`查看任务详情 ${job.fileName}`}
                    >
                      <TableCell className="max-w-28 truncate font-mono text-xs text-muted-foreground lg:max-w-none">
                        {job.id.slice(0, 12)}
                        <span className="block text-[10px] text-muted-foreground/60">{formatTime(job.submittedAt)}</span>
                      </TableCell>
                      <TableCell className="min-w-0 max-w-40 lg:max-w-64">
                        <FileLabel name={job.fileName} />
                        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground" title={`${job.source.deviceName} · ${job.pageCount}页×${job.options.copies}份 · ${formatBytes(job.sizeBytes)}`}>
                          {job.source.deviceName} · {job.pageCount}页×{job.options.copies}份{job.options.duplex !== 'none' ? ' · 双面' : ''} · {formatBytes(job.sizeBytes)}
                        </span>
                      </TableCell>
                      <TableCell className="max-w-24 truncate text-xs lg:max-w-36" title={printer?.name ?? job.printerId}>
                        {printer?.name ?? job.printerId}
                      </TableCell>
                      <TableCell>
                        <JobStateBadge state={job.state} />
                      </TableCell>
                      <TableCell>
                        <JobProgress job={job} />
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          {canCancel && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-8 text-muted-foreground transition-colors duration-200 hover:text-destructive"
                              aria-label={`取消任务 ${job.fileName}`}
                              onClick={(e) => {
                                e.stopPropagation()
                                void cancel(job)
                              }}
                            >
                              <X className="size-3.5" aria-hidden />
                            </Button>
                          )}
                          {canRetry && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-8 transition-colors duration-200"
                              aria-label={`重试任务 ${job.fileName}`}
                              onClick={(e) => {
                                e.stopPropagation()
                                void retry(job)
                              }}
                            >
                              <RotateCcw className="size-3.5" aria-hidden />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </FadingScrollArea>

          {/* <md：卡片列表（每张卡完整可见，无需横向滚动，触控目标 ≥44px） */}
          <div className="max-h-[32rem] space-y-2 overflow-y-auto rounded-md border p-2 [scrollbar-width:thin] md:hidden">
            {filtered.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">没有匹配的任务</p>
            ) : (
              filtered.map((job, i) => (
                <JobCard
                  key={job.id}
                  job={job}
                  printerName={printers.find((p) => p.id === job.printerId)?.name ?? job.printerId}
                  zebra={i % 2 === 1}
                  onSelect={() => setSelectedJobId(job.id)}
                  onCancel={() => void cancel(job)}
                  onRetry={() => void retry(job)}
                />
              ))
            )}
          </div>
        </CardContent>
      </Card>

      <JobDetailSheet jobId={selectedJobId} job={selectedJob} onClose={() => setSelectedJobId(null)} client={client} />
    </div>
  )
}

function JobDetailSheet({ jobId, job, onClose, client }: { jobId: string | null; job: PrintJob | null; onClose: () => void; client: ReturnType<typeof useOpsClient> }) {
  const printers = useOpsStore((s) => s.printers)
  const printer = job ? printers.find((p) => p.id === job.printerId) : null
  const duration =
    job?.startedAt && job.endedAt ? formatDuration(new Date(job.endedAt).getTime() - new Date(job.startedAt).getTime()) : null

  return (
    <SheetUI open={!!jobId} onOpenChange={(v) => (!v ? onClose() : null)}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        {job ? (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2 pr-6">
                <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="truncate">{job.fileName}</span>
              </SheetTitle>
              <SheetDescription className="font-mono">{job.id}</SheetDescription>
            </SheetHeader>
            <div className="mt-4 space-y-5 px-4 pb-8">
              <div className="flex items-center gap-2">
                <JobStateBadge state={job.state} />
                {job.state === 'processing' || job.state === 'paused' ? <JobProgress job={job} /> : null}
              </div>

              <dl className="grid grid-cols-1 gap-x-4 gap-y-2 rounded-lg border bg-muted/20 p-3 text-xs sm:grid-cols-2">
                <Detail label="打印机" value={printer ? `${printer.name}（${printer.backend.toUpperCase()}）` : job.printerId} />
                <Detail label="来源设备" value={`${job.source.deviceName}（${job.source.platform}）`} />
                {job.backendJobId && <Detail label="后端任务" value={`#${job.backendJobId}`} />}
                {job.backendJobUri && <Detail label="后端 URI" value={job.backendJobUri} />}
                <Detail label="页数 × 份数" value={`${job.pageCount} × ${job.options.copies}`} />
                <Detail label="总纸张" value={`${job.sheetsTotal} 张${job.printedSheets ? `（已打 ${job.printedSheets}）` : ''}`} />
                <Detail label="文件大小" value={formatBytes(job.sizeBytes)} />
                <Detail label="耗时" value={duration ?? '—'} />
                <Detail label="提交时间" value={formatTime(job.submittedAt)} />
                <Detail label="完成时间" value={job.endedAt ? formatTime(job.endedAt) : '—'} />
                <Detail label="纸张" value={job.options.paperSize} />
                <Detail label="色彩" value={job.options.colorMode === 'color' ? '彩色' : '黑白'} />
                <Detail label="单双面" value={job.options.duplex === 'none' ? '单面' : job.options.duplex === 'long-edge' ? '双面·长边' : '双面·短边'} />
                <Detail label="质量" value={{ draft: '草稿', normal: '标准', high: '高质量' }[job.options.quality]} />
                {job.options.pageRange && <Detail label="页面范围" value={job.options.pageRange} />}
                {job.error && (
                  <div className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-destructive sm:col-span-2">{job.error}</div>
                )}
                <div className="sm:col-span-2">
                  <p className="mb-1 text-muted-foreground">墨量消耗</p>
                  <p className="font-mono text-[11px]">
                    C {(job.inkUsed.cyan * 100).toFixed(2)}% · M {(job.inkUsed.magenta * 100).toFixed(2)}% · Y {(job.inkUsed.yellow * 100).toFixed(2)}% · K{' '}
                    {(job.inkUsed.black * 100).toFixed(2)}%
                  </p>
                </div>
              </dl>

              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" asChild>
                  <a href={client.jobDocumentUrl(job.id)} target="_blank" rel="noreferrer">
                    <Download className="size-3.5" aria-hidden />
                    原始 PDF
                  </a>
                </Button>
                {['failed', 'cancelled'].includes(job.state) && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      try {
                        const r = await client.retryJob(job.id)
                        toast.success('已重新排队', { description: r.message })
                      } catch (e) {
                        toast.error('重试失败', { description: (e as Error).message })
                      }
                    }}
                  >
                    <RotateCcw className="size-3.5" aria-hidden />
                    重新排队
                  </Button>
                )}
                {['pending', 'processing', 'paused'].includes(job.state) && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      try {
                        const r = await client.cancelJob(job.id)
                        toast.success('任务已取消', { description: r.message })
                      } catch (e) {
                        toast.error('取消失败', { description: (e as Error).message })
                      }
                    }}
                  >
                    <X className="size-3.5" aria-hidden />
                    取消任务
                  </Button>
                )}
              </div>

              <section aria-label="任务时间线">
                <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
                  <Sheet className="size-4 text-muted-foreground" aria-hidden />
                  状态时间线（{job.timeline.length} 条）
                </h3>
                <div className="max-h-96 overflow-y-auto pr-2 [scrollbar-width:thin]">
                  <TimelineList timeline={job.timeline} />
                </div>
              </section>
            </div>
          </>
        ) : (
          <div className="flex h-full items-center justify-center">
            <EmptyState title="选择一个任务查看详情" />
          </div>
        )}
      </SheetContent>
    </SheetUI>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-2">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="truncate text-right font-medium" title={value}>{value}</dd>
    </div>
  )
}

/** <md 任务卡片：完整信息无横向滚动，操作按钮 44px 触控目标 */
function JobCard({
  job,
  printerName,
  zebra,
  onSelect,
  onCancel,
  onRetry,
}: {
  job: PrintJob
  printerName: string
  zebra: boolean
  onSelect: () => void
  onCancel: () => void
  onRetry: () => void
}) {
  const canCancel = ['pending', 'processing', 'paused'].includes(job.state)
  const canRetry = ['failed', 'cancelled'].includes(job.state)
  return (
    <article
      className={cn(
        'min-w-0 rounded-lg border p-3 transition-colors duration-150 active:bg-primary/5',
        zebra && 'bg-muted/25',
      )}
    >
      <button type="button" className="block w-full min-w-0 text-left" onClick={onSelect} aria-label={`查看任务详情 ${job.fileName}`}>
        <div className="flex min-w-0 items-center justify-between gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium" title={job.fileName}>
            {job.fileName}
          </span>
          <JobStateBadge state={job.state} />
        </div>
        <p className="mt-1 truncate text-[11px] text-muted-foreground" title={`${printerName} · ${job.source.deviceName}`}>
          {printerName} · {job.source.deviceName}
        </p>
        <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/70">
          {job.id.slice(0, 12)} · {formatTime(job.submittedAt)} · {job.pageCount}页×{job.options.copies}份 · {formatBytes(job.sizeBytes)}
        </p>
        <div className="mt-2">
          <JobProgress job={job} />
        </div>
      </button>
      {(canCancel || canRetry) && (
        <div className="mt-2 flex justify-end gap-1 border-t pt-2">
          {canCancel && (
            <Button size="sm" variant="outline" className="h-11 min-w-11 gap-1.5 text-muted-foreground" aria-label={`取消任务 ${job.fileName}`} onClick={onCancel}>
              <X className="size-3.5" aria-hidden />
              取消
            </Button>
          )}
          {canRetry && (
            <Button size="sm" variant="outline" className="h-11 min-w-11 gap-1.5" aria-label={`重试任务 ${job.fileName}`} onClick={onRetry}>
              <RotateCcw className="size-3.5" aria-hidden />
              重试
            </Button>
          )}
        </div>
      )}
    </article>
  )
}
