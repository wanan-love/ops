'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { CircleCheck, CircleHelp, CircleX, Download, Link2, Network, Plus, RefreshCw, RadioTower, ScanSearch, ServerCog, Globe, FileDown } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { useOpsClient, useOpsStore } from './store'
import { BackendBadge, EmptyState, formatTime } from './widgets'
import type { DiscoveredIpPrinter, VippInfo } from '@/lib/ops/client'
import type { BackendStatus } from '@/lib/ops/types'
import type { TabValue } from './ops-app'

/** Virtual IPP 各档案的能力说明（用于引导用户理解能力缺失场景） */
const VIPP_PROFILE_DESC: Record<string, string> = {
  Full: '完整能力：彩色/双面/纸型/份数 + marker-levels 耗材（IPP 来源）——验证 SUPPLIED',
  Basic: '无 marker-* 属性（耗材 UNKNOWN）、无 sides-supported（双面 UNKNOWN）——验证「读取不到 ≠ 不支持」',
  Mono: 'color-supported=false（UNSUPPORTED 黑白）、无耗材、仅 A4',
  Minimal: '只暴露 printer-state + printer-name，其余能力全 UNKNOWN——验证最吝啬设备',
}

export function BackendsView({ goto }: { goto: (v: TabValue) => void }) {
  const client = useOpsClient()
  const printers = useOpsStore((s) => s.printers)
  const refresh = useOpsStore((s) => s.refresh)
  const [backends, setBackends] = useState<BackendStatus[] | null>(null)
  const [vipp, setVipp] = useState<VippInfo | null>(null)
  const [scanning, setScanning] = useState(false)
  const [mdnsPrinters, setMdnsPrinters] = useState<DiscoveredIpPrinter[] | null>(null)
  const [uri, setUri] = useState('')
  const [adding, setAdding] = useState(false)
  const [busyKeys, setBusyKeys] = useState<string[]>([])

  const loadStatus = useCallback(async () => {
    try {
      const [b, v] = await Promise.all([client.backends(), client.vippPrinters()])
      setBackends(b.backends)
      setVipp(v)
    } catch {
      /* 静默重试 */
    }
  }, [client])

  useEffect(() => {
    void loadStatus()
    const t = setInterval(() => void loadStatus(), 8000)
    return () => clearInterval(t)
  }, [loadStatus])

  const importVipp = async (key: string, displayName?: string) => {
    setBusyKeys((k) => [...k, key])
    try {
      const { printer } = await client.importPrinter({ backend: 'ipp', key, displayName })
      toast.success('打印机已导入（真实 IPP 协议探测）', {
        description: `${printer.name} · ${printer.backendUri ?? ''} · 能力报告已生成`,
      })
      await refresh()
    } catch (e) {
      toast.error('导入失败', { description: (e as Error).message })
    } finally {
      setBusyKeys((k) => k.filter(x => x !== key))
    }
  }

  const scanMdns = async () => {
    setScanning(true)
    try {
      const { printers: found } = await client.mdnsScan()
      setMdnsPrinters(found)
      toast.success('mDNS 扫描完成', { description: `发现 ${found.length} 台网络 IPP 打印机（_ipp._tcp / Bonjour）` })
    } catch (e) {
      toast.error('扫描失败', { description: (e as Error).message })
    } finally {
      setScanning(false)
    }
  }

  const importFromMdns = async (p: DiscoveredIpPrinter) => {
    setBusyKeys((k) => [...k, p.uri])
    try {
      const { printer } = await client.addPrinterUri({ uri: p.uri, displayName: p.name })
      toast.success('已通过 URI 添加打印机', { description: `${printer.name}（${p.uri}）` })
      await refresh()
    } catch (e) {
      toast.error('添加失败', { description: (e as Error).message })
    } finally {
      setBusyKeys((k) => k.filter(x => x !== p.uri))
    }
  }

  const addUri = async () => {
    const trimmed = uri.trim()
    if (!trimmed) {
      toast.error('请输入 IPP URI')
      return
    }
    if (!/^ipps?:\/\//.test(trimmed)) {
      toast.error('URI 格式无效', { description: '应以 ipp:// 开头，例如 ipp://192.168.1.50/ipp/print' })
      return
    }
    setAdding(true)
    try {
      const { printer } = await client.addPrinterUri({ uri: trimmed })
      toast.success('打印机已添加并完成能力探测', {
        description: `${printer.name} · 探测结果见打印机页能力报告（读取不到的能力将标记 UNKNOWN）`,
      })
      setUri('')
      await refresh()
    } catch (e) {
      toast.error('添加失败', { description: (e as Error).message })
    } finally {
      setAdding(false)
    }
  }

  const importedKeys = new Set(printers.filter((p) => p.backend !== 'mock').map((p) => p.backendKey ?? ''))

  return (
    <div className="space-y-4">
      {/* ---------------------------------------------------------------- 后端可用性 */}
      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ServerCog className="size-4 text-muted-foreground" aria-hidden />
            打印后端（PrinterBackend 统一接口）
          </CardTitle>
          <Button size="sm" variant="outline" onClick={() => void loadStatus()}>
            <RefreshCw className="size-3.5" aria-hidden />
            刷新状态
          </Button>
        </CardHeader>
        <CardContent>
          {!backends ? (
            <div className="space-y-2">
              <div className="h-16 animate-pulse rounded-lg bg-muted/50" />
              <div className="h-16 animate-pulse rounded-lg bg-muted/50" />
            </div>
          ) : (
            <div className="grid gap-2 md:grid-cols-2">
              {backends.map((b) => (
                <div key={b.kind} className="flex min-w-0 items-start gap-3 rounded-lg border p-3 transition-colors duration-200 hover:border-primary/30">
                  <div className="mt-0.5 shrink-0" aria-hidden>
                    {b.available ? (
                      <CircleCheck className="size-4 text-emerald-600 dark:text-emerald-400" />
                    ) : (
                      <CircleX className="size-4 text-zinc-400 dark:text-zinc-500" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <BackendBadge backend={b.kind} />
                      <span className={cn('text-[11px] font-medium', b.available ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-500')}>
                        {b.available ? '可用' : '当前环境不可用'}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/80">{b.note}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
          <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground/70">
            Core 通过统一 PrinterBackend 接口访问任意后端（listPrinters / getCapabilities / getStatus / submitJob / getJobStatus / cancelJob），平台差异全部隔离在后端层。
            CUPS 与 Windows 后端需对应宿主环境，当前为代码完备状态（待真实硬件验证）。
          </p>
        </CardContent>
      </Card>

      {/* ---------------------------------------------------------------- Virtual IPP Server */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <RadioTower className="size-4 text-muted-foreground" aria-hidden />
            Virtual IPP Server
            {vipp && (
              <Badge variant="secondary" className="font-mono text-[10px]">
                :{vipp.port} · RFC 8010/8011
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs leading-relaxed text-muted-foreground">
            本机内置的「虚拟 IPP 打印机」服务——使用<strong className="text-foreground">真实 IPP 二进制协议</strong>（Get-Printer-Attributes / Print-Job / Get-Job-Attributes / Cancel-Job），
            无需实体打印机即可验证 IPPPrinterBackend 全链路。四台打印机分别模拟<strong className="text-foreground">不同能力缺失组合</strong>，用于测试能力三态模型。
          </p>
          {!vipp ? (
            <div className="h-20 animate-pulse rounded-lg bg-muted/50" />
          ) : vipp.printers.length === 0 ? (
            <EmptyState title="Virtual IPP Server 未启用" hint="可通过环境变量 OPS_VIPP_ENABLED=0 关闭；默认随 Host 启动" />
          ) : (
            <div className="grid gap-2 lg:grid-cols-2">
              {vipp.printers.map((p) => {
                const imported = importedKeys.has(p.id)
                const busy = busyKeys.includes(p.id)
                return (
                  <div key={p.id} className="min-w-0 rounded-lg border p-3 transition-colors duration-200 hover:border-primary/30">
                    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-medium">{p.name}</span>
                          <Badge variant="secondary" className="text-[10px]">Profile: {p.profile}</Badge>
                        </div>
                        <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/70" title={`ipp://localhost:${vipp.port}/printers/${p.id}`}>
                          ipp://localhost:{vipp.port}/printers/{p.id}
                        </p>
                      </div>
                      <Button size="sm" variant={imported ? 'secondary' : 'default'} disabled={busy || imported} onClick={() => void importVipp(p.id)}>
                        {busy ? <RefreshCw className="size-3.5 animate-spin" aria-hidden /> : imported ? <CircleCheck className="size-3.5" aria-hidden /> : <Download className="size-3.5" aria-hidden />}
                        {imported ? '已导入' : '导入'}
                      </Button>
                    </div>
                    <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground/80">{VIPP_PROFILE_DESC[p.profile] ?? ''}</p>
                    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground/70">
                      <span>状态：{p.state}{p.stateReasons[0] && p.stateReasons[0] !== 'none' ? `（${p.stateReasons.join(', ')}）` : ''}</span>
                      <span>排队 {p.queuedJobs}</span>
                      <span>完成 {p.completedJobs}</span>
                      <span>{p.ppm} ppm</span>
                      <span>更新 {formatTime(p.updatedAt)}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---------------------------------------------------------------- mDNS 扫描 */}
      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Network className="size-4 text-muted-foreground" aria-hidden />
            mDNS / Bonjour 网络打印机发现
          </CardTitle>
          <Button size="sm" onClick={() => void scanMdns()} disabled={scanning}>
            {scanning ? <RefreshCw className="size-3.5 animate-spin" aria-hidden /> : <ScanSearch className="size-3.5" aria-hidden />}
            扫描 _ipp._tcp
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs leading-relaxed text-muted-foreground">
            组播查询 <code className="rounded bg-muted px-1 font-mono text-[10px]">_ipp._tcp.local</code> /{' '}
            <code className="rounded bg-muted px-1 font-mono text-[10px]">_universal._sub._ipp._tcp</code>（纯 TS UDP 实现，RFC 6762/6763）。
            Virtual IPP Server 会同时自通告——本机即可完成发现→添加→探测→打印的完整闭环。
          </p>
          {mdnsPrinters === null ? (
            <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground/70">点击「扫描」发现局域网 IPP 打印机（约 2 秒收集窗口）</p>
          ) : mdnsPrinters.length === 0 ? (
            <EmptyState icon={<CircleHelp className="size-5" aria-hidden />} title="未发现网络 IPP 打印机" hint="当前局域网没有响应 mDNS 的设备；Virtual IPP 自通告需 Host 在运行中" />
          ) : (
            <ul className="space-y-2">
              {mdnsPrinters.map((p) => (
                <li key={p.uri} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg border p-3 transition-colors duration-200 hover:border-primary/30">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Globe className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="truncate text-sm font-medium" title={p.name}>{p.name}</span>
                      <Badge variant="secondary" className="font-mono text-[10px]">{p.ip}:{p.port}</Badge>
                    </div>
                    <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/70" title={p.uri}>{p.uri}</p>
                    {p.txt?.ty && <p className="mt-0.5 truncate text-[11px] text-muted-foreground/70">{p.txt.ty}{p.txt.note ? ` · ${p.txt.note}` : ''}</p>}
                  </div>
                  <Button size="sm" variant="outline" disabled={busyKeys.includes(p.uri)} onClick={() => void importFromMdns(p)}>
                    <Link2 className="size-3.5" aria-hidden />
                    添加
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* ---------------------------------------------------------------- 手动 URI */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Plus className="size-4 text-muted-foreground" aria-hidden />
            手动添加 IPP 打印机（URI）
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="ipp-uri">IPP URI（支持 ipps 的设备暂不支持 TLS，会明确报错）</Label>
            <div className="flex gap-2">
              <Input
                id="ipp-uri"
                value={uri}
                onChange={(e) => setUri(e.target.value)}
                placeholder="ipp://192.168.1.50/ipp/print"
                className="min-w-0 flex-1 font-mono text-xs"
                inputMode="url"
              />
              <Button onClick={() => void addUri()} disabled={adding} className="shrink-0">
                {adding ? <RefreshCw className="size-3.5 animate-spin" aria-hidden /> : <FileDown className="size-3.5" aria-hidden />}
                添加并探测
              </Button>
            </div>
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground/70">
            添加后将通过 IPP Get-Printer-Attributes 真实探测能力：读取不到的属性标记为 UNKNOWN（≠不支持），打印仍可正常提交——由设备驱动最终裁决。
            添加成功后可到 <button className="underline decoration-dotted underline-offset-2" onClick={() => goto('printers')}>打印机页</button> 查看能力报告，或直接
            <button className="underline decoration-dotted underline-offset-2" onClick={() => goto('print')}>提交打印</button>。
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
