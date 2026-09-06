'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { CircuitBoard, ChevronDown, Layers3, Link2Off, MapPin, Palette, Plus, Printer, PrinterCheck, RefreshCw, Share2, Trash2, Gauge, Globe } from 'lucide-react'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { useOpsClient, useOpsStore } from './store'
import { BackendBadge, CapabilityStateBadge, ConsumablePanel, InkBars, PrinterStatusBadge, EmptyState, formatTime } from './widgets'
import type { Capability, Printer } from '@/lib/ops/types'

export function PrintersView() {
  const printers = useOpsStore((s) => s.printers)
  const devMode = useOpsStore((s) => s.hostInfo?.devMode ?? false)
  const client = useOpsClient()
  const [creating, setCreating] = useState(false)

  const mockCount = printers.filter((p) => p.backend === 'mock').length
  const realCount = printers.length - mockCount

  const toggleShare = async (printer: Printer) => {
    try {
      const { printer: updated } = await client.updatePrinter(printer.id, { shared: !printer.shared })
      toast.success(updated.shared ? `已共享「${updated.name}」` : `已取消共享「${updated.name}」`, {
        description: updated.shared ? '局域网设备现在可以发现并使用它' : '客户端将不再看到这台打印机',
      })
    } catch (e) {
      toast.error('操作失败', { description: (e as Error).message })
    }
  }

  const testPrint = async (printer: Printer) => {
    try {
      const { job } = await client.testPrint(printer.id)
      toast.success('测试页已发送', { description: `任务 ${job.id} 已加入 ${printer.name} 队列` })
    } catch (e) {
      toast.error('发送失败', { description: (e as Error).message })
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 flex-1 basis-52 text-sm text-muted-foreground">
          {printers.filter((p) => p.shared).length} / {printers.length} 台已共享
          {devMode ? ` · ${mockCount} 台 Mock 虚拟 + ` : ' · '}
          {realCount} 台真实后端{devMode ? '（IPP/CUPS/Windows）' : '（Windows 打印栈 / CUPS / IPP）'}
        </p>
        {/* 虚拟打印机创建仅开发/测试模式（正式运行环境不创建/不显示虚拟打印机——产品红线） */}
        {devMode && (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
              <Plus className="size-3.5" aria-hidden />
              添加虚拟打印机
            </Button>
          </div>
        )}
      </div>

      {printers.length === 0 ? (
        <EmptyState
          icon={<Printer className="size-6" aria-hidden />}
          title="还没有打印机"
          hint={
            devMode
              ? '创建一台 Virtual Printer，或在「打印后端」页导入 Virtual IPP / 真实打印机'
              : '正在自动发现系统真实打印机（Windows 打印栈 / CUPS）……也可在「打印后端」页手动触发同步或添加 IPP URI'
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {printers.map((printer) => (
            <PrinterCard key={printer.id} printer={printer} onToggleShare={() => toggleShare(printer)} onTestPrint={() => testPrint(printer)} />
          ))}
        </div>
      )}

      {devMode && <CreatePrinterDialog open={creating} onOpenChange={setCreating} />}
    </div>
  )
}

function PrinterCard({ printer, onToggleShare, onTestPrint }: { printer: Printer; onToggleShare: () => void; onTestPrint: () => void }) {
  const client = useOpsClient()
  const [deleting, setDeleting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  const activeJob = useOpsStore((s) => s.jobs.find((j) => j.id === printer.activeJobId))

  const duplexLabel = printer.capabilities.duplex === 'none' ? '单面' : printer.capabilities.duplex === 'both' ? '双面（长/短边）' : printer.capabilities.duplex === 'long-edge' ? '双面·长边' : '双面·短边'
  const isRealBackend = printer.backend !== 'mock'
  const report = printer.capabilityReport

  /** 耗材展示策略：Mock → 模拟墨量（SYSTEM 来源，定义即真实）；真实后端 → 仅当 capabilityReport.consumables 为 supported 才显示，UNKNOWN 时隐藏模块 */
  const consumablesSupported = report?.consumables.state === 'supported' && Array.isArray(report.consumables.value) && report.consumables.value.length > 0

  const refreshCaps = async () => {
    setRefreshing(true)
    try {
      const { printer: updated } = await client.refreshCapabilities(printer.id)
      const unknownCount = Object.values(updated.capabilityReport ?? {}).filter((c: { state?: string }) => c && typeof c === 'object' && c.state === 'unknown').length
      toast.success('能力已重新探测', {
        description: unknownCount > 0 ? `探测完成：${unknownCount} 项为 UNKNOWN（读取不到 ≠ 不支持，不影响打印）` : '探测完成：全部能力已确认',
      })
    } catch (e) {
      toast.error('探测失败', { description: (e as Error).message })
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <Card className="min-w-0 gap-4 transition-all duration-200 hover:border-primary/25 hover:shadow-md">
      <CardHeader className="flex-row items-start justify-between gap-2 pb-0">
        <div className="min-w-0">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <span className="truncate">{printer.name}</span>
            {printer.isSystemDefault && (
              <Badge variant="secondary" className="bg-primary/10 text-[10px] text-primary" title="系统默认打印机（Windows Win32_Printer.Default / CUPS lpstat -d 实时读取）">
                系统默认
              </Badge>
            )}
            {printer.test && <Badge variant="secondary" className="text-[10px]">TEST</Badge>}
            <BackendBadge backend={printer.backend} />
          </CardTitle>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{printer.description}</p>
          {printer.backendUri && (
            <p className="mt-0.5 flex items-center gap-1 truncate font-mono text-[10px] text-muted-foreground/70" title={printer.backendUri}>
              <Globe className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{printer.backendUri}</span>
            </p>
          )}
          {printer.location && (
            <p className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground/70">
              <MapPin className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{printer.location}</span>
            </p>
          )}
        </div>
        <PrinterStatusBadge status={printer.status} className="shrink-0" />
      </CardHeader>

      <CardContent className="space-y-3">
        {printer.statusMessage && (
          <p className="rounded-md border border-orange-500/30 bg-orange-500/10 px-2.5 py-1.5 text-xs text-orange-700 dark:text-orange-400" role="status">
            {printer.statusMessage}
          </p>
        )}
        {activeJob && activeJob.state !== 'completed' && (
          <p className="truncate text-xs text-muted-foreground">
            当前任务：{activeJob.fileName}（{activeJob.progress.toFixed(0)}%）
          </p>
        )}

        {/* 耗材模块：有可靠数据才显示（用户硬性要求：UNKNOWN 时直接隐藏，不显示假 0%） */}
        {isRealBackend ? (
          consumablesSupported ? (
            <ConsumablePanel consumables={report!.consumables.value!} timestamp={report!.consumables.timestamp} />
          ) : null
        ) : (
          <InkBars ink={printer.ink} />
        )}

        <div className="flex flex-wrap gap-1.5 rounded-lg text-[11px]">
          <Chip icon={<Palette className="size-3" aria-hidden />}>{printer.capabilities.color ? '彩色' : '黑白'}</Chip>
          <Chip icon={<Layers3 className="size-3" aria-hidden />}>{duplexLabel}</Chip>
          <Chip icon={<CircuitBoard className="size-3" aria-hidden />}>{printer.capabilities.paperSizes.join(' / ')}</Chip>
          <Chip icon={<Gauge className="size-3" aria-hidden />}>{printer.speedOverridePpm ?? printer.capabilities.ppm} ppm</Chip>
          <Chip icon={<PrinterCheck className="size-3" aria-hidden />}>{printer.capabilities.maxResolutionDpi} dpi</Chip>
        </div>

        {/* 能力报告（三态 + 来源 + 时间戳，真实后端打印机） */}
        {report && (
          <Collapsible open={reportOpen} onOpenChange={setReportOpen}>
            <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 rounded-md border bg-muted/30 px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors duration-200 hover:bg-muted/60">
              <span>
                能力报告（三态 / 来源 / 时间戳）{report.probes.length > 0 && <span className="ml-1 text-[10px] text-muted-foreground/60">{report.probes.length} 个来源探测</span>}
              </span>
              <ChevronDown className={cn('size-3.5 shrink-0 transition-transform duration-200', reportOpen && 'rotate-180')} aria-hidden />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-2 space-y-1.5 rounded-md border p-2.5">
                <CapRow label="彩色" cap={report.color} render={(v) => (v ? '支持' : '不支持')} />
                <CapRow label="双面" cap={report.duplex} render={(v) => (v === 'none' ? '仅单面' : v === 'both' ? '长边 + 短边' : v === 'long-edge' ? '长边' : '短边')} />
                <CapRow label="份数上限" cap={report.maxCopies} render={(v) => `1–${v}`} />
                <CapRow label="纸张尺寸" cap={report.paperSizes} render={(v) => v.join(' / ')} />
                <CapRow label="分辨率" cap={report.maxResolutionDpi} render={(v) => `${v} dpi`} />
                <CapRow label="速度" cap={report.ppm} render={(v) => `${v} ppm`} />
                <CapRow
                  label="耗材"
                  cap={report.consumables}
                  render={(v) => `${v.length} 项（${v.map((c) => (c.levelPct !== null ? `${c.levelPct}%` : '未知')).join(' / ')}）`}
                />
                {report.probes.length > 0 && (
                  <div className="mt-2 border-t pt-2">
                    <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">来源探测（失败不影响打印可用性）</p>
                    <ul className="space-y-0.5">
                      {report.probes.map((p, i) => (
                        <li key={`${p.source}-${i}`} className="flex items-center gap-2 text-[11px]">
                          <span className={cn('size-1.5 shrink-0 rounded-full', p.ok ? 'bg-emerald-500' : 'bg-red-500')} aria-hidden />
                          <span className="w-16 shrink-0 font-mono text-[10px] text-muted-foreground">{p.source}</span>
                          <span className="min-w-0 flex-1 break-words text-muted-foreground">
                            {p.ok ? `成功（${p.durationMs}ms${p.detail ? ` · ${p.detail}` : ''}）` : p.error ?? '失败'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}

        <div className="grid grid-cols-4 gap-2 rounded-lg bg-muted/50 p-2 text-center">
          {[
            { label: '提交', value: printer.stats.submitted },
            { label: '完成', value: printer.stats.completed },
            { label: '失败', value: printer.stats.failed },
            { label: '张数', value: printer.stats.sheets },
          ].map((s) => (
            <div key={s.label}>
              <p className="font-mono text-sm font-semibold tabular-nums">{s.value}</p>
              <p className="text-[10px] text-muted-foreground">{s.label}</p>
            </div>
          ))}
        </div>
      </CardContent>

      <CardFooter className="flex flex-wrap items-center gap-2 border-t pt-4">
        <label className="flex cursor-pointer items-center gap-2 text-sm" aria-label={`共享开关：${printer.name}`}>
          <Switch checked={printer.shared} onCheckedChange={onToggleShare} />
          <span className="flex items-center gap-1 text-muted-foreground">
            {printer.shared ? <Share2 className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden /> : <Link2Off className="size-3.5" aria-hidden />}
            {printer.shared ? '已共享' : '未共享'}
          </span>
        </label>
        <div className="ml-auto flex flex-wrap gap-2">
          {isRealBackend && (
            <Button size="sm" variant="outline" onClick={() => void refreshCaps()} disabled={refreshing}>
              <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} aria-hidden />
              刷新能力
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={onTestPrint} disabled={busy}>
            <PrinterCheck className="size-3.5" aria-hidden />
            测试页
          </Button>
          {printer.virtual && (
            <Button size="sm" variant="ghost" onClick={() => setDeleting(true)} aria-label={`删除 ${printer.name}`} className="text-muted-foreground hover:text-destructive">
              <Trash2 className="size-3.5" aria-hidden />
            </Button>
          )}
        </div>
      </CardFooter>

      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除「{printer.name}」？</AlertDialogTitle>
            <AlertDialogDescription>将删除这台虚拟打印机及其全部任务工件（PDF / job.json / result.json），操作不可撤销。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async () => {
                setBusy(true)
                try {
                  await client.deletePrinter(printer.id)
                  toast.success('打印机已删除', { description: printer.name })
                } catch (e) {
                  toast.error('删除失败', { description: (e as Error).message })
                } finally {
                  setBusy(false)
                }
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}

function Chip({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border bg-muted/40 px-2 py-0.5 text-muted-foreground">
      {icon}
      {children}
    </span>
  )
}

/** 能力报告行：三态徽章 + 值 + 来源 + 时间戳 */
function CapRow<T>({ label, cap, render }: { label: string; cap: Capability<T>; render: (value: T) => string }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
      <span className="w-14 shrink-0 text-muted-foreground">{label}</span>
      <CapabilityStateBadge state={cap.state} />
      <span className="min-w-0 flex-1 break-words text-foreground/80 line-clamp-2" title={cap.detail}>
        {cap.state !== 'unknown' && cap.value !== null ? render(cap.value) : cap.detail ? cap.detail : '未读取到（读取不到 ≠ 不支持）'}
      </span>
      <span className="shrink-0 font-mono text-[9px] uppercase text-muted-foreground/50">{cap.source} · {formatTime(cap.timestamp)}</span>
    </div>
  )
}

function CreatePrinterDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const client = useOpsClient()
  const refresh = useOpsStore((s) => s.refresh)
  const [name, setName] = useState('')
  const [location, setLocation] = useState('')
  const [color, setColor] = useState(true)
  const [duplex, setDuplex] = useState<'none' | 'long-edge' | 'both'>('both')
  const [ppm, setPpm] = useState(10)
  const [shared, setShared] = useState(true)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (!name.trim()) {
      toast.error('请输入打印机名称')
      return
    }
    setBusy(true)
    try {
      const { printer } = await client.createPrinter({
        name: name.trim(),
        location: location.trim() || undefined,
        shared,
        capabilities: { color, duplex, ppm: Math.max(1, Math.min(600, ppm)) },
      })
      toast.success('虚拟打印机已创建', { description: `${printer.name}（${color ? '彩色' : '黑白'} · ${ppm} ppm）` })
      await refresh()
      onOpenChange(false)
      setName('')
    } catch (e) {
      toast.error('创建失败', { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>添加 Virtual Printer</DialogTitle>
          <DialogDescription>创建一台虚拟打印机（MockPrinterBackend），无需物理设备即可模拟完整打印流程。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="vp-name">名称</Label>
            <Input id="vp-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：三楼走廊打印机" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="vp-location">位置（可选）</Label>
            <Input id="vp-location" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="例如：三楼走廊" />
          </div>
          <div className="flex items-center justify-between rounded-md border px-3 py-2.5">
            <Label htmlFor="vp-color" className="cursor-pointer">
              彩色打印能力
            </Label>
            <Checkbox id="vp-color" checked={color} onCheckedChange={(v) => setColor(!!v)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>双面能力</Label>
              <Select value={duplex} onValueChange={(v) => setDuplex(v as 'none' | 'long-edge' | 'both')}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="both">双面（长/短边）</SelectItem>
                  <SelectItem value="long-edge">双面 · 长边</SelectItem>
                  <SelectItem value="none">仅单面</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="vp-ppm">速度（ppm）</Label>
              <Input id="vp-ppm" type="number" min={1} max={600} value={ppm} onChange={(e) => setPpm(Number(e.target.value) || 10)} />
            </div>
          </div>
          <div className="flex items-center justify-between rounded-md border px-3 py-2.5">
            <Label htmlFor="vp-shared" className="cursor-pointer">
              立即共享给局域网设备
            </Label>
            <Switch id="vp-shared" checked={shared} onCheckedChange={setShared} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? '创建中…' : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
