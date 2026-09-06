'use client'

import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  ChevronLeft,
  ChevronRight,
  Download,
  FileImage,
  FileText,
  Loader2,
  Plus,
  RadioTower,
  RefreshCw,
  ScanLine,
  ScanSearch,
  Trash2,
  X,
} from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import type { ScanDeviceSource, ScanJob, ScanJobState } from '@/lib/ops/types'
import { SCAN_JOB_STATE_LABEL } from '@/lib/ops/types'
import { useOpsClient, useOpsStore } from './store'
import { EmptyState, FadingScrollArea, formatDuration, formatTime } from './widgets'

/** 扫描任务状态徽章 */
function ScanStateBadge({ state }: { state: ScanJobState }) {
  const cls: Record<ScanJobState, string> = {
    pending: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400',
    scanning: 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-400',
    completed: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
    failed: 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400',
    cancelled: 'border-zinc-500/40 bg-zinc-500/10 text-zinc-600 dark:text-zinc-400',
  }
  return (
    <Badge variant="outline" className={cn('shrink-0 gap-1', cls[state])}>
      {state === 'scanning' && <Loader2 className="size-3 animate-spin" aria-hidden />}
      {SCAN_JOB_STATE_LABEL[state]}
    </Badge>
  )
}

/** 设备来源徽章：vscan=虚拟（内置）/ mdns=发现（局域网）/ manual=手动 */
function SourceBadge({ source }: { source: ScanDeviceSource }) {
  if (source === 'manual') {
    return (
      <Badge variant="secondary" className="shrink-0">
        手动
      </Badge>
    )
  }
  const isVscan = source === 'vscan'
  return (
    <Badge
      variant="outline"
      className={cn(
        'shrink-0',
        isVscan
          ? 'border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-400'
          : 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-400',
      )}
    >
      {isVscan ? '虚拟' : '发现'}
    </Badge>
  )
}

interface ScanFormState {
  dpi: number
  colorMode: 'RGB' | 'Grayscale'
  inputSource: 'Platen' | 'Feeder'
}

/** 扫描参数摘要（dpi · 色彩 · 输源 · 耗时） */
function jobSummary(job: ScanJob): string {
  const parts = [
    `${job.dpi} dpi`,
    job.colorMode === 'RGB' ? '彩色' : '灰度',
    job.inputSource === 'Platen' ? '平板' : '送稿器',
  ]
  if (job.durationMs != null) parts.push(`耗时 ${formatDuration(job.durationMs)}`)
  return parts.join(' · ')
}

/** 字节数人性化（KB/MB） */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

/** 单个扫描任务卡片（内部维护当前预览页码） */
function ScanJobCard({ job }: { job: ScanJob }) {
  const client = useOpsClient()
  const startScan = useOpsStore((s) => s.startScan)
  const cancelScanJob = useOpsStore((s) => s.cancelScanJob)
  const deleteScanJob = useOpsStore((s) => s.deleteScanJob)
  const exportScanPdf = useOpsStore((s) => s.exportScanPdf)
  const [currentPage, setCurrentPage] = useState(1)
  const [exporting, setExporting] = useState(false)

  const pageCount = Math.max(1, job.images.length)
  const page = Math.min(Math.max(1, currentPage), pageCount)
  const running = job.state === 'pending' || job.state === 'scanning'

  const cancel = async () => {
    try {
      await cancelScanJob(job.id)
      toast.success('已取消扫描任务', { description: job.deviceName })
    } catch (e) {
      toast.error('取消失败', { description: (e as Error).message })
    }
  }

  const remove = async () => {
    try {
      await deleteScanJob(job.id)
      toast.success('已删除扫描任务', { description: job.deviceName })
    } catch (e) {
      toast.error('删除失败', { description: (e as Error).message })
    }
  }

  const rescan = async () => {
    try {
      await startScan({
        deviceId: job.deviceId,
        format: job.format,
        dpi: job.dpi,
        colorMode: job.colorMode,
        inputSource: job.inputSource,
      })
      toast.success('已提交扫描任务', { description: `${job.deviceName} · ${job.dpi} dpi` })
    } catch (e) {
      toast.error('提交失败', { description: (e as Error).message })
    }
  }

  const download = async () => {
    try {
      const res = await fetch(client.scanImageUrl(job.id, page))
      if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `ops-scan-${job.id}-p${page}.png`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      toast.success('已下载扫描图像', { description: `ops-scan-${job.id}-p${page}.png` })
    } catch (e) {
      toast.error('下载失败', { description: (e as Error).message })
    }
  }

  /** 导出 PDF（幂等：后端已导出则复用缓存） */
  const exportPdf = async () => {
    setExporting(true)
    try {
      const updated = await exportScanPdf(job.id)
      toast.success('已导出 PDF', {
        description: updated.pdf ? `${updated.pdf.pages} 页 · ${formatBytes(updated.pdf.bytes)}（A4 合成）` : undefined,
      })
    } catch (e) {
      toast.error('PDF 导出失败', { description: (e as Error).message })
    } finally {
      setExporting(false)
    }
  }

  /** 下载导出的 PDF */
  const downloadPdf = async () => {
    try {
      const res = await fetch(client.scanPdfUrl(job.id))
      if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `ops-scan-${job.id}.pdf`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      toast.success('已下载 PDF', { description: `ops-scan-${job.id}.pdf` })
    } catch (e) {
      toast.error('下载失败', { description: (e as Error).message })
    }
  }

  return (
    <article className="min-w-0 space-y-2 rounded-lg border bg-card p-3">
      {/* 行 1：状态 · 设备名 · 时间 · 快捷操作 */}
      <div className="flex min-w-0 items-center gap-2">
        <ScanStateBadge state={job.state} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={job.deviceName}>
          {job.deviceName}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{formatTime(job.startedAt)}</span>
        {running ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 text-muted-foreground hover:text-red-600"
            onClick={() => void cancel()}
            aria-label={`取消任务 ${job.deviceName}`}
          >
            <X className="size-3.5" aria-hidden />
          </Button>
        ) : null}
        {job.state === 'completed' ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 text-muted-foreground hover:text-red-600"
            onClick={() => void remove()}
            aria-label={`删除任务 ${job.deviceName}`}
          >
            <Trash2 className="size-3.5" aria-hidden />
          </Button>
        ) : null}
      </div>

      {/* 行 2：参数摘要 */}
      <p className="text-[11px] text-muted-foreground">{jobSummary(job)}</p>

      {/* 扫描中：indeterminate 进度 + 页数 */}
      {job.state === 'scanning' ? (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>正在扫描，请稍候…</span>
            <span className="font-mono">
              {job.pagesDone}/{job.pagesTotal || '…'} 页
            </span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
            <div className="w-2/3 animate-pulse rounded-full bg-primary" />
          </div>
        </div>
      ) : null}

      {/* 已完成：预览 + 分页 + 操作行 */}
      {job.state === 'completed' ? (
        <div className="space-y-2">
          <div
            className="rounded-md border p-2"
            style={{
              backgroundImage:
                'linear-gradient(45deg,#e4e4e7 25%,transparent 25%),linear-gradient(-45deg,#e4e4e7 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#e4e4e7 75%),linear-gradient(-45deg,transparent 75%,#e4e4e7 75%)',
              backgroundSize: '12px 12px',
              backgroundPosition: '0 0,0 6px,6px -6px,-6px 0px',
            }}
          >
            <img
              src={client.scanImageUrl(job.id, page)}
              alt={`扫描结果第 ${page} 页`}
              className="mx-auto h-40 object-contain"
              loading="lazy"
            />
          </div>
          {pageCount > 1 ? (
            <div className="flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                disabled={page <= 1}
                onClick={() => setCurrentPage(page - 1)}
                aria-label="上一页"
              >
                <ChevronLeft className="size-3.5" aria-hidden />
              </Button>
              <span className="font-mono">
                第 {page} / {pageCount} 页
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                disabled={page >= pageCount}
                onClick={() => setCurrentPage(page + 1)}
                aria-label="下一页"
              >
                <ChevronRight className="size-3.5" aria-hidden />
              </Button>
            </div>
          ) : null}
          {/* PDF 导出信息行（已导出时显示） */}
          {job.pdf ? (
            <p className="flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-2 py-1 text-[11px] text-emerald-700 dark:text-emerald-400">
              <FileText className="size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate">
                PDF 已生成：{job.pdf.pages} 页 · {formatBytes(job.pdf.bytes)} · A4
              </span>
              <span className="shrink-0 font-mono text-[10px] text-emerald-600/70 dark:text-emerald-400/70">
                {formatTime(job.pdf.exportedAt)}
              </span>
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" className="h-7 gap-1.5" onClick={() => void download()}>
              <Download className="size-3.5" aria-hidden />
              下载 PNG
            </Button>
            {job.pdf ? (
              <Button variant="outline" size="sm" className="h-7 gap-1.5" onClick={() => void downloadPdf()}>
                <FileText className="size-3.5" aria-hidden />
                下载 PDF
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 text-primary hover:text-primary"
                onClick={() => void exportPdf()}
                disabled={exporting}
              >
                {exporting ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <FileText className="size-3.5" aria-hidden />}
                {exporting ? '导出中…' : '导出 PDF'}
              </Button>
            )}
            <Button variant="outline" size="sm" className="h-7 gap-1.5" onClick={() => void rescan()}>
              <RefreshCw className="size-3.5" aria-hidden />
              重新扫描
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-muted-foreground hover:text-red-600"
              onClick={() => void remove()}
            >
              <Trash2 className="size-3.5" aria-hidden />
              删除
            </Button>
          </div>
        </div>
      ) : null}

      {/* 失败：错误详情 + 重试 */}
      {job.state === 'failed' ? (
        <div className="min-w-0 space-y-1.5">
          <p className="break-words text-xs text-red-600 dark:text-red-400" title={job.error ?? undefined}>
            {job.error ?? '未知错误'}
          </p>
          <Button variant="outline" size="sm" className="h-7 gap-1.5" onClick={() => void rescan()}>
            <RefreshCw className="size-3.5" aria-hidden />
            重新扫描
          </Button>
        </div>
      ) : null}

      {/* 已取消：提示 + 重扫 */}
      {job.state === 'cancelled' ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-muted-foreground">已取消</p>
          <Button variant="outline" size="sm" className="h-7 gap-1.5" onClick={() => void rescan()}>
            <RefreshCw className="size-3.5" aria-hidden />
            重新扫描
          </Button>
        </div>
      ) : null}
    </article>
  )
}

/** 扫描（eSCL）主视图：左侧设备 + 参数，右侧任务列表 */
export function ScanView() {
  const scanDevices = useOpsStore((s) => s.scanDevices)
  const scanJobs = useOpsStore((s) => s.scanJobs)
  const hostInfo = useOpsStore((s) => s.hostInfo)
  const connected = useOpsStore((s) => s.connected)
  const refreshScan = useOpsStore((s) => s.refreshScan)
  const scanMdns = useOpsStore((s) => s.scanMdns)
  const startScan = useOpsStore((s) => s.startScan)
  const addScanDevice = useOpsStore((s) => s.addScanDevice)
  const removeScanDevice = useOpsStore((s) => s.removeScanDevice)

  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [mdnsScanning, setMdnsScanning] = useState(false)
  const [addingManual, setAddingManual] = useState(false)
  const [manualUrl, setManualUrl] = useState('')
  const [form, setForm] = useState<ScanFormState>({ dpi: 300, colorMode: 'RGB', inputSource: 'Platen' })

  // 挂载 + 连接恢复时刷新扫描设备与任务
  useEffect(() => {
    void refreshScan()
  }, [connected, refreshScan])

  // 未选择或选择失效时回退到第一台设备
  const selectedDevice = useMemo(
    () => scanDevices.find((d) => d.id === selectedDeviceId) ?? scanDevices[0] ?? null,
    [scanDevices, selectedDeviceId],
  )

  const handleMdns = async () => {
    setMdnsScanning(true)
    try {
      const devices = await scanMdns()
      toast.success('mDNS 扫描完成', { description: `共发现 ${devices.length} 台扫描设备` })
    } catch (e) {
      toast.error('mDNS 扫描失败', { description: (e as Error).message })
    } finally {
      setMdnsScanning(false)
    }
  }

  const submit = async () => {
    if (!selectedDevice) return
    setSubmitting(true)
    try {
      await startScan({
        deviceId: selectedDevice.id,
        format: 'image/png',
        dpi: form.dpi,
        colorMode: form.colorMode,
        inputSource: form.inputSource,
      })
      toast.success('已提交扫描任务', { description: `${selectedDevice.name} · ${form.dpi} dpi` })
    } catch (e) {
      toast.error('提交失败', { description: (e as Error).message })
    } finally {
      setSubmitting(false)
    }
  }

  const handleAddManual = async () => {
    const url = manualUrl.trim()
    if (!url) return
    setAddingManual(true)
    try {
      const device = await addScanDevice({ baseUrl: url })
      toast.success('已添加扫描设备', { description: device.name })
      setManualUrl('')
      setSelectedDeviceId(device.id)
    } catch (e) {
      toast.error('添加失败', { description: (e as Error).message })
    } finally {
      setAddingManual(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* 头部：标题 + mDNS 扫描 + 虚拟扫描服务徽章 */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight">扫描（eSCL）</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">eSCL / AirScan 标准扫描协议 · 设备与打印后端独立发现</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void handleMdns()} disabled={mdnsScanning}>
            {mdnsScanning ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RadioTower className="size-4" aria-hidden />}
            {mdnsScanning ? '扫描中…' : 'mDNS 扫描'}
          </Button>
          {hostInfo?.vscanPort ? (
            <Badge
              variant="outline"
              className="border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-400"
            >
              虚拟扫描服务 :{hostInfo.vscanPort}
            </Badge>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        {/* 左栏：设备 + 参数 + 手动添加 */}
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <Card>
            <CardHeader className="flex-row items-center justify-between gap-3 pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <ScanLine className="size-4 text-muted-foreground" aria-hidden />
                扫描设备
              </CardTitle>
              <Badge variant="secondary">{scanDevices.length}</Badge>
            </CardHeader>
            <CardContent className="space-y-1 p-3 pt-0">
              {scanDevices.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed py-8 text-center">
                  <ScanLine className="size-6 text-muted-foreground/60" aria-hidden />
                  <p className="text-sm font-medium text-muted-foreground">暂无扫描设备</p>
                  <p className="max-w-[16rem] text-xs leading-relaxed text-muted-foreground/70">
                    点击右上 mDNS 扫描发现局域网设备，或在下方手动添加
                  </p>
                </div>
              ) : (
                scanDevices.map((device) => {
                  const active = selectedDevice?.id === device.id
                  return (
                    <div key={device.id} className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        className={cn(
                          'h-auto w-full min-w-0 flex-1 justify-start gap-3 rounded-md px-3 py-2.5 text-left',
                          active && 'bg-accent/50 ring-1 ring-primary',
                        )}
                        onClick={() => setSelectedDeviceId(device.id)}
                        aria-pressed={active}
                      >
                        <ScanLine
                          className={cn('size-4 shrink-0', active ? 'text-primary' : 'text-muted-foreground')}
                          aria-hidden
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="truncate text-sm font-medium" title={device.name}>
                              {device.name}
                            </span>
                            <SourceBadge source={device.source} />
                          </span>
                          <span
                            className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground/70"
                            title={`${device.id} · ${device.baseUrl}`}
                          >
                            {device.id} · {device.baseUrl}
                          </span>
                        </span>
                      </Button>
                      {device.source === 'manual' ? (
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8 shrink-0 text-muted-foreground hover:text-red-600"
                              aria-label={`删除设备 ${device.name}`}
                            >
                              <Trash2 className="size-3.5" aria-hidden />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>删除扫描设备？</AlertDialogTitle>
                              <AlertDialogDescription>
                                将移除「{device.name}」（{device.baseUrl}）。仅手动添加的设备可删除，之后可随时重新添加。
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>取消</AlertDialogCancel>
                              <AlertDialogAction
                                className="bg-red-600 text-white hover:bg-red-700"
                                onClick={() => {
                                  void removeScanDevice(device.id)
                                    .then(() => toast.success('已删除扫描设备', { description: device.name }))
                                    .catch((e: Error) => toast.error('删除失败', { description: e.message }))
                                }}
                              >
                                删除
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      ) : null}
                    </div>
                  )
                })
              )}
            </CardContent>
          </Card>

          {/* 参数卡：选中设备后可用 */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">扫描参数</CardTitle>
              {selectedDevice ? (
                <p className="truncate text-xs text-muted-foreground" title={selectedDevice.baseUrl}>
                  {selectedDevice.name} · {selectedDevice.baseUrl}
                </p>
              ) : null}
            </CardHeader>
            {selectedDevice ? (
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="scan-dpi">分辨率（DPI）</Label>
                  <Select
                    value={String(form.dpi)}
                    onValueChange={(v) => setForm((f) => ({ ...f, dpi: Number(v) }))}
                  >
                    <SelectTrigger id="scan-dpi" aria-label="选择扫描分辨率">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="150">150 dpi · 快速草稿</SelectItem>
                      <SelectItem value="300">300 dpi · 标准文档</SelectItem>
                      <SelectItem value="600">600 dpi · 高清</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-muted-foreground">数值越高越清晰，扫描耗时越长</p>
                </div>

                <div className="space-y-2">
                  <Label>色彩模式</Label>
                  <RadioGroup
                    value={form.colorMode}
                    onValueChange={(v) => setForm((f) => ({ ...f, colorMode: v as ScanFormState['colorMode'] }))}
                    className="flex gap-6"
                  >
                    <label
                      htmlFor="scan-color-rgb"
                      className="flex cursor-pointer items-center gap-2 text-sm has-[button[data-state=checked]]:text-foreground"
                    >
                      <RadioGroupItem value="RGB" id="scan-color-rgb" />
                      彩色
                    </label>
                    <label
                      htmlFor="scan-color-gray"
                      className="flex cursor-pointer items-center gap-2 text-sm has-[button[data-state=checked]]:text-foreground"
                    >
                      <RadioGroupItem value="Grayscale" id="scan-color-gray" />
                      灰度
                    </label>
                  </RadioGroup>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="scan-source">输入源</Label>
                  <Select
                    value={form.inputSource}
                    onValueChange={(v) => setForm((f) => ({ ...f, inputSource: v as ScanFormState['inputSource'] }))}
                  >
                    <SelectTrigger id="scan-source" aria-label="选择输入源">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Platen">平板（单页）</SelectItem>
                      <SelectItem value="Feeder">送稿器（多页文档）</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <p className="flex items-start gap-1.5 rounded-md bg-muted/50 px-2 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
                  <FileImage className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  <span>
                    输出 PNG 图像页（逐页预览/下载）；完成后可<span className="text-foreground/80">导出 PDF</span>
                    （A4 合成 · 横图自动转横向页）
                  </span>
                </p>

                <Button className="w-full" onClick={() => void submit()} disabled={submitting || !selectedDevice}>
                  {submitting ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  ) : (
                    <ScanSearch className="size-4" aria-hidden />
                  )}
                  {submitting ? '提交中…' : '开始扫描'}
                </Button>
              </CardContent>
            ) : (
              <CardContent>
                <p className="rounded-md border border-dashed py-6 text-center text-xs text-muted-foreground">
                  请先选择扫描设备
                </p>
              </CardContent>
            )}
          </Card>

          {/* 手动添加 */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Plus className="size-3.5 text-muted-foreground" aria-hidden />
                手动添加扫描设备
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  void handleAddManual()
                }}
              >
                <Input
                  value={manualUrl}
                  onChange={(e) => setManualUrl(e.target.value)}
                  placeholder="http://192.168.1.50:8080"
                  className="min-w-0 flex-1 font-mono text-xs"
                  inputMode="url"
                  aria-label="扫描设备 eSCL 地址"
                />
                <Button type="submit" variant="outline" className="shrink-0" disabled={!manualUrl.trim() || addingManual}>
                  {addingManual ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Plus className="size-4" aria-hidden />}
                  添加
                </Button>
              </form>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                eSCL 标准端口通常为 80/443/8080，路径 /eSCL/ScanJobs 由协议自动处理
              </p>
            </CardContent>
          </Card>
        </div>

        {/* 右栏：任务列表（WS 实时更新） */}
        <Card className="min-w-0 lg:col-span-3">
          <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 pb-3">
            <div className="flex min-w-0 items-center gap-2">
              <CardTitle className="text-base">扫描任务</CardTitle>
              <Badge variant="secondary">{scanJobs.length}</Badge>
            </div>
            <p className="text-xs text-muted-foreground">WebSocket 实时更新 · 最新在前</p>
          </CardHeader>
          <CardContent className="p-0">
            {scanJobs.length === 0 ? (
              <div className="p-3">
                <EmptyState
                  icon={<ScanLine className="size-5" aria-hidden />}
                  title="暂无扫描任务"
                  hint="选择左侧设备并设置参数后，点击「开始扫描」提交任务"
                />
              </div>
            ) : (
              <FadingScrollArea className="max-h-[32rem]">
                <div className="space-y-2 p-3">
                  {scanJobs.map((job) => (
                    <ScanJobCard key={job.id} job={job} />
                  ))}
                </div>
              </FadingScrollArea>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
