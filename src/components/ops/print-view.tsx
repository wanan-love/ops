'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { CheckCircle2, FileText, Files, Layers3, Loader2, Palette, Send, UploadCloud, Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useOpsClient, useOpsStore } from './store'
import { formatBytes } from './widgets'
import type { PrintJob, PrintOptions } from '@/lib/ops/types'
import type { TabValue } from './ops-app'

async function isValidPdf(file: File): Promise<boolean> {
  const head = await file.slice(0, 5).text()
  return head === '%PDF-'
}

export function PrintView({ goto }: { goto: (v: TabValue) => void }) {
  const printers = useOpsStore((s) => s.printers)
  const client = useOpsClient()
  const [file, setFile] = useState<File | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submittedJob, setSubmittedJob] = useState<PrintJob | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const sharedPrinters = useMemo(() => printers.filter((p) => p.shared && !p.test), [printers])
  const [printerId, setPrinterId] = useState<string>('')
  const effectivePrinter = sharedPrinters.find((p) => p.id === printerId) ?? sharedPrinters[0]

  const [options, setOptions] = useState<PrintOptions>({
    paperSize: 'A4',
    colorMode: 'color',
    duplex: 'none',
    copies: 1,
    quality: 'normal',
    pageRange: '',
  })

  const pickFile = useCallback(async (f: File | null | undefined) => {
    if (!f) return
    setSubmittedJob(null)
    if (f.type && f.type !== 'application/pdf' && !f.name.toLowerCase().endsWith('.pdf')) {
      setFile(null)
      setFileError('仅支持 PDF 文件')
      return
    }
    if (f.size > 20 * 1024 * 1024) {
      setFile(null)
      setFileError('文件超过 20MB 上限')
      return
    }
    if (!(await isValidPdf(f))) {
      setFile(null)
      setFileError('文件不是有效的 PDF（缺少 %PDF 魔数）')
      return
    }
    setFile(f)
    setFileError(null)
  }, [])

  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      setDragging(false)
      await pickFile(e.dataTransfer.files?.[0])
    },
    [pickFile],
  )

  const useSample = useCallback(async () => {
    try {
      const res = await fetch(client.samplePdfUrl(2))
      if (!res.ok) throw new Error('生成示例文档失败')
      const blob = await res.blob()
      await pickFile(new File([blob], 'ops-sample-2pages.pdf', { type: 'application/pdf' }))
      toast.success('已加载示例文档', { description: 'OpenPrintShare 生成的 2 页演示 PDF' })
    } catch (e) {
      toast.error('获取示例失败', { description: (e as Error).message })
    }
  }, [client, pickFile])

  const submit = async () => {
    if (!file || !effectivePrinter) return
    setSubmitting(true)
    try {
      const job = await client.submitJob({
        file,
        fileName: file.name,
        printerId: effectivePrinter.id,
        options: { ...options, pageRange: options.pageRange?.trim() || undefined },
      })
      setSubmittedJob(job)
      toast.success('打印任务已提交', {
        description: `${job.fileName} → ${effectivePrinter.name}（${job.pageCount} 页 × ${job.options.copies} 份 ≈ ${job.sheetsTotal} 张）`,
      })
    } catch (e) {
      toast.error('提交失败', { description: (e as Error).message })
    } finally {
      setSubmitting(false)
    }
  }

  const caps = effectivePrinter?.capabilities
  const duplexOptions =
    !caps || caps.duplex === 'none'
      ? [{ value: 'none', label: '单面' }]
      : caps.duplex === 'both'
        ? [
            { value: 'none', label: '单面' },
            { value: 'long-edge', label: '双面 · 长边翻转' },
            { value: 'short-edge', label: '双面 · 短边翻转' },
          ]
        : [
            { value: 'none', label: '单面' },
            { value: caps.duplex, label: caps.duplex === 'long-edge' ? '双面 · 长边翻转' : '双面 · 短边翻转' },
          ]

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="min-w-0">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <UploadCloud className="size-4 text-muted-foreground" aria-hidden />
            1. 选择 PDF 文档
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div
            role="button"
            tabIndex={0}
            aria-label="上传 PDF（点击或拖放）"
            onClick={() => inputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click()
            }}
            onDragOver={(e) => {
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={
              'flex min-h-40 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-6 text-center transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-ring ' +
              (dragging ? 'border-primary bg-primary/5' : 'border-border hover:border-muted-foreground/40 hover:bg-accent/30')
            }
          >
            {file ? (
              <>
                <FileText className="size-8 text-emerald-600 dark:text-emerald-400" aria-hidden />
                <p className="max-w-full truncate text-sm font-medium">{file.name}</p>
                <p className="font-mono text-xs text-muted-foreground">{formatBytes(file.size)}</p>
                <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); inputRef.current?.click() }}>
                  更换文件
                </Button>
              </>
            ) : (
              <>
                <UploadCloud className="size-8 text-muted-foreground/50" aria-hidden />
                <p className="text-sm font-medium text-muted-foreground">点击选择或拖放 PDF 到此处</p>
                <p className="text-xs text-muted-foreground/70">最大 20MB · 原始 PDF 将存档到 Host 数据目录</p>
              </>
            )}
            <input
              ref={inputRef}
              type="file"
              accept="application/pdf,.pdf"
              className="hidden"
              onChange={(e) => {
                void pickFile(e.target.files?.[0])
                e.target.value = ''
              }}
            />
          </div>

          {fileError && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
              {fileError}
            </p>
          )}

          <Button variant="outline" className="w-full transition-colors duration-200 hover:border-primary/40" onClick={useSample}>
            <Wand2 className="size-3.5" aria-hidden />
            使用示例文档（Host 生成）
          </Button>
        </CardContent>
      </Card>

      <Card className="min-w-0">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Palette className="size-4 text-muted-foreground" aria-hidden />
            2. 打印选项
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="printer-select">目标打印机（仅显示已共享）</Label>
            <Select value={effectivePrinter?.id ?? ''} onValueChange={setPrinterId} disabled={sharedPrinters.length === 0}>
              <SelectTrigger id="printer-select">
                <SelectValue placeholder={sharedPrinters.length === 0 ? '没有已共享的打印机' : '选择打印机'} />
              </SelectTrigger>
              <SelectContent>
                {sharedPrinters.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                    {p.status !== 'online' && p.status !== 'busy' ? `（${p.status}）` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {effectivePrinter && (
              <p className="text-[11px] text-muted-foreground/70">
                {effectivePrinter.capabilities.color ? '支持彩色' : '仅黑白'} · {effectivePrinter.capabilities.paperSizes.join('/')} ·{' '}
                {effectivePrinter.speedOverridePpm ?? effectivePrinter.capabilities.ppm} ppm
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>纸张尺寸</Label>
              <Select value={options.paperSize} onValueChange={(v) => setOptions((o) => ({ ...o, paperSize: v }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(caps?.paperSizes ?? ['A4']).map((size) => (
                    <SelectItem key={size} value={size}>
                      {size}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="copies">份数（1–{caps?.maxCopies ?? 99}）</Label>
              <div className="flex items-center gap-1.5">
                <Button variant="outline" size="icon" className="size-9" aria-label="减少份数" onClick={() => setOptions((o) => ({ ...o, copies: Math.max(1, o.copies - 1) }))}>
                  −
                </Button>
                <Input
                  id="copies"
                  type="number"
                  min={1}
                  max={caps?.maxCopies ?? 99}
                  value={options.copies}
                  onChange={(e) => setOptions((o) => ({ ...o, copies: Math.max(1, Math.min(caps?.maxCopies ?? 99, Number(e.target.value) || 1)) }))}
                  className="w-16 text-center"
                />
                <Button variant="outline" size="icon" className="size-9" aria-label="增加份数" onClick={() => setOptions((o) => ({ ...o, copies: Math.min(caps?.maxCopies ?? 99, o.copies + 1) }))}>
                  +
                </Button>
              </div>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>色彩模式{caps && !caps.color ? '（该打印机仅黑白）' : ''}</Label>
            <RadioGroup
              value={caps?.color === false ? 'monochrome' : options.colorMode}
              onValueChange={(v) => setOptions((o) => ({ ...o, colorMode: v as 'color' | 'monochrome' }))}
              className="flex gap-4"
              disabled={caps?.color === false}
            >
              <label className="flex cursor-pointer items-center gap-1.5 text-sm" aria-label="彩色打印">
                <RadioGroupItem value="color" />
                <Palette className="size-3.5 text-muted-foreground" aria-hidden />
                彩色
              </label>
              <label className="flex cursor-pointer items-center gap-1.5 text-sm" aria-label="黑白打印">
                <RadioGroupItem value="monochrome" />
                黑白
              </label>
            </RadioGroup>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>单双面</Label>
              <Select value={options.duplex} onValueChange={(v) => setOptions((o) => ({ ...o, duplex: v as PrintOptions['duplex'] }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {duplexOptions.map((d) => (
                    <SelectItem key={d.value} value={d.value}>
                      {d.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>质量</Label>
              <Select value={options.quality} onValueChange={(v) => setOptions((o) => ({ ...o, quality: v as PrintOptions['quality'] }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="draft">草稿（省墨）</SelectItem>
                  <SelectItem value="normal">标准</SelectItem>
                  <SelectItem value="high">高质量</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="page-range">页面范围（可选，例如 1-3,5）</Label>
            <Input id="page-range" value={options.pageRange ?? ''} onChange={(e) => setOptions((o) => ({ ...o, pageRange: e.target.value }))} placeholder="留空打印全部页面" />
          </div>

          <Button className="w-full" size="lg" onClick={submit} disabled={!file || !effectivePrinter || submitting}>
            {submitting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Send className="size-4" aria-hidden />}
            {submitting ? '提交中…' : '提交打印'}
          </Button>

          {submittedJob && (
            <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 shadow-xs" role="status">
              <p className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 className="size-4" aria-hidden />
                任务已加入队列：{submittedJob.id}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {submittedJob.pageCount} 页 × {submittedJob.options.copies} 份 ≈ {submittedJob.sheetsTotal} 张 · 队列位置按提交顺序
              </p>
              <Button size="sm" variant="outline" className="mt-2" onClick={() => goto('queue')}>
                <Files className="size-3.5" aria-hidden />
                在队列中查看
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
