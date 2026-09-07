'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { CircleCheck, CircleHelp, CircleX, Cable, Download, Link2, Lock, Network, Plus, RefreshCw, RadioTower, ScanSearch, ServerCog, Globe, FileDown } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { useOpsClient, useOpsStore } from './store'
import { BackendBadge, EmptyState, formatTime } from './widgets'
import type { DiscoveredIpPrinter, VippInfo, VledmState, VpjlState } from '@/lib/ops/client'
import type { BackendStatus, BackendKind } from '@/lib/ops/types'
import { BACKEND_LABEL } from '@/lib/ops/types'
import type { TabValue } from './ops-app'

/** Virtual IPP 各档案的能力说明（用于引导用户理解能力缺失场景） */
const VIPP_PROFILE_DESC: Record<string, string> = {
  Full: '完整能力：彩色/双面/纸型/份数 + marker-levels 耗材（IPP 来源）——验证 SUPPLIED',
  Basic: '无 marker-* 属性（耗材 UNKNOWN）、无 sides-supported（双面 UNKNOWN）——验证「读取不到 ≠ 不支持」',
  Mono: 'color-supported=false（UNSUPPORTED 黑白）、无耗材、仅 A4',
  Minimal: '只暴露 printer-state + printer-name，其余能力全 UNKNOWN——验证最吝啬设备',
}

/** Virtual PJL 调试状态注入清单（key = 后端 VpjlCondition；label/code/hint 前端展示） */
const PJL_CONDITIONS: Array<{ key: string; label: string; hint: string }> = [
  { key: 'ready', label: '就绪', hint: 'CODE 10001 → online（READY）' },
  { key: 'busy', label: '打印中', hint: 'CODE 10004 → busy（PRINTING）' },
  { key: 'warmup', label: '预热', hint: 'CODE 10003 → online（WARMING UP，不改状态）' },
  { key: 'offline', label: '离线', hint: 'CODE 10002 → offline' },
  { key: 'paper-out', label: '缺纸', hint: 'CODE 40014 → paper-out（状态融合验证）' },
  { key: 'paper-jam', label: '卡纸', hint: 'CODE 40019 → paper-jam' },
  { key: 'door-open', label: '门开', hint: 'CODE 40017 → error（DOOR OPEN）' },
  { key: 'toner-low', label: '碳粉低', hint: 'CODE 40036 → 耗材 8%（不映射状态——耗材域）' },
  { key: 'toner-empty', label: '碳粉尽', hint: 'CODE 40037 → 耗材 0%' },
]

const PJL_CONDITION_LABEL: Record<string, string> = {
  ready: '就绪',
  busy: '打印中',
  warmup: '预热中',
  offline: '离线',
  'paper-out': '缺纸',
  'paper-jam': '卡纸',
  'door-open': '盖板开启',
  'toner-low': '碳粉低',
  'toner-empty': '碳粉尽',
}

const PJL_CONDITION_CODE: Record<string, string> = {
  ready: '10001',
  busy: '10004',
  warmup: '10003',
  offline: '10002',
  'paper-out': '40014',
  'paper-jam': '40019',
  'door-open': '40017',
  'toner-low': '40036',
  'toner-empty': '40037',
}

/** Virtual HP LEDM/CDM 调试状态注入清单（key = 后端 VledmCondition；StatusCategory 为 HPLIP 官方枚举） */
const HP_LEDM_CONDITIONS: Array<{ key: string; label: string; hint: string }> = [
  { key: 'ready', label: '就绪', hint: 'StatusCategory=ready → online' },
  { key: 'busy', label: '打印中', hint: 'StatusCategory=processing → busy' },
  { key: 'paper-out', label: '缺纸', hint: 'StatusCategory=trayEmptyOrOpen → paper-out（状态融合）' },
  { key: 'paper-jam', label: '卡纸', hint: 'StatusCategory=jamInPrinter → paper-jam' },
  { key: 'door-open', label: '门开', hint: 'StatusCategory=closeDoorOrCover → error' },
  { key: 'hard-error', label: '硬错误', hint: 'StatusCategory=hardError → error' },
  { key: 'toner-low', label: '墨量低', hint: '黑色墨 8%（StatusCategory=ready 不映射状态——耗材域）' },
  { key: 'toner-empty', label: '墨尽', hint: '黑色墨 0% + ConsumableState=empty' },
]

const HP_LEDM_CONDITION_LABEL: Record<string, string> = {
  ready: '就绪',
  busy: '打印中',
  'paper-out': '缺纸',
  'paper-jam': '卡纸',
  'door-open': '盖板开启',
  'hard-error': '硬错误',
  'toner-low': '墨量低',
  'toner-empty': '墨尽',
}

const HP_LEDM_CATEGORY: Record<string, string> = {
  ready: 'ready',
  busy: 'processing',
  'paper-out': 'trayEmptyOrOpen',
  'paper-jam': 'jamInPrinter',
  'door-open': 'closeDoorOrCover',
  'hard-error': 'hardError',
  'toner-low': 'ready',
  'toner-empty': 'ready',
}

const HP_LEDM_STYLE_LABEL: Record<string, string> = {
  namespaced: '带命名空间（真实 HP 同款 psdyn:/ccdyn:/mhdyn:）',
  bare: '无前缀（验证宽容解析）',
  '404': '全部 404（验证 UNKNOWN 兕底）',
}

export function BackendsView({ goto }: { goto: (v: TabValue) => void }) {
  const client = useOpsClient()
  const printers = useOpsStore((s) => s.printers)
  const refresh = useOpsStore((s) => s.refresh)
  const hostInfo = useOpsStore((s) => s.hostInfo)
  const vpjlPort = hostInfo?.vpjlPort ?? 3067
  const vledmPort = hostInfo?.vledmPort ?? 3068
  const [backends, setBackends] = useState<BackendStatus[] | null>(null)
  const [vipp, setVipp] = useState<VippInfo | null>(null)
  const [vpjl, setVpjl] = useState<VpjlState | null>(null)
  const [pjlBusy, setPjlBusy] = useState(false)
  const [vledm, setVledm] = useState<VledmState | null>(null)
  const [hpBusy, setHpBusy] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [mdnsPrinters, setMdnsPrinters] = useState<DiscoveredIpPrinter[] | null>(null)
  const [uri, setUri] = useState('')
  const [adding, setAdding] = useState(false)
  const [busyKeys, setBusyKeys] = useState<string[]>([])
  const [syncing, setSyncing] = useState(false)

  const loadStatus = useCallback(async () => {
    try {
      const [b, v, j, h] = await Promise.all([client.backends(), client.vippPrinters(), client.vpjlState().catch(() => null), client.vledmState().catch(() => null)])
      setBackends(b.backends)
      setVipp(v)
      setVpjl(j?.state ?? null)
      setVledm(h?.state ?? null)
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

  /** 注入 Virtual PJL 调试状态（对齐 vipp.setCondition 的调试用途） */
  const injectPjl = async (condition: string) => {
    setPjlBusy(true)
    try {
      const { state } = await client.setVpjlCondition(condition)
      setVpjl(state)
      toast.success(`已注入 PJL 状态：${PJL_CONDITION_LABEL[condition] ?? condition}`, {
        description: `CODE ${PJL_CONDITION_CODE[condition] ?? '?'}——到打印机页「刷新能力」验证 VENDOR_API 回读`,
      })
    } catch (e) {
      toast.error('注入失败', { description: (e as Error).message })
    } finally {
      setPjlBusy(false)
    }
  }

  /** 注入 Virtual HP LEDM/CDM 调试状态（StatusCategory 为 HPLIP 官方枚举） */
  const injectHpLedm = async (condition: string) => {
    setHpBusy(true)
    try {
      const { state } = await client.setVledmCondition(condition)
      setVledm(state)
      toast.success(`已注入 HP LEDM 状态：${HP_LEDM_CONDITION_LABEL[condition] ?? condition}`, {
        description: `StatusCategory=${HP_LEDM_CATEGORY[condition] ?? '?'}——到打印机页「刷新能力」验证 VENDOR_API 回读`,
      })
    } catch (e) {
      toast.error('注入失败', { description: (e as Error).message })
    } finally {
      setHpBusy(false)
    }
  }

  /** 切换 LEDM 应答风格（namespaced/bare/404：验证宽容解析与 UNKNOWN 兜底） */
  const injectHpStyle = async (style: string) => {
    setHpBusy(true)
    try {
      const { state } = await client.setVledmStyle(style)
      setVledm(state)
      toast.success(`已切换 LEDM 应答风格：${style}`, {
        description: HP_LEDM_STYLE_LABEL[style] ?? style,
      })
    } catch (e) {
      toast.error('切换失败', { description: (e as Error).message })
    } finally {
      setHpBusy(false)
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
      toast.error('URI 格式无效', { description: '应以 ipp:// 或 ipps:// 开头，例如 ipp://192.168.1.50/ipp/print' })
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
  const devMode = hostInfo?.devMode ?? false

  /** 手动触发系统打印机同步（windows / cups 枚举 → 幂等导入；与后台 60s 自动同步同一入口） */
  const syncSystemPrinters = async () => {
    setSyncing(true)
    try {
      const { results, summary } = await client.autosyncBackends()
      const lines = results
        .map((r) => `${BACKEND_LABEL[r.kind as BackendKind] ?? r.kind}：${r.available ? `${r.imported} 新导入 / ${r.updated} 刷新` : '不可用（如实报告）'}`)
        .join('；')
      toast[summary.imported > 0 ? 'success' : 'info'](summary.imported > 0 ? `已发现 ${summary.imported} 台新系统打印机` : '同步完成（无新增）', {
        description: lines,
      })
      await refresh()
      await loadStatus()
    } catch (e) {
      toast.error('同步失败', { description: (e as Error).message })
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* ---------------------------------------------------------------- 后端可用性 */}
      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ServerCog className="size-4 text-muted-foreground" aria-hidden />
            打印后端（PrinterBackend 统一接口）
          </CardTitle>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => void syncSystemPrinters()} disabled={syncing} title="枚举 Windows 打印栈 / CUPS 系统真实打印机并幂等导入（后台每 60s 自动执行）">
              <RefreshCw className={cn('size-3.5', syncing && 'animate-spin')} aria-hidden />
              {syncing ? '同步中…' : '同步系统打印机'}
            </Button>
            <Button size="sm" variant="outline" onClick={() => void loadStatus()}>
              <RefreshCw className="size-3.5" aria-hidden />
              刷新状态
            </Button>
          </div>
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
                    {/* break-words：说明含长 token（如 DC_PAPERNAMES/DC_DUPLEX/DC_COPIES/DC_BINNAMES）时必须可断行，防 393px 溢出 */}
                    <p className="mt-1 text-[11px] leading-relaxed break-words text-muted-foreground/80">{b.note}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
          <p className="mt-3 text-[11px] leading-relaxed break-words text-muted-foreground/70">
            Core 通过统一 PrinterBackend 接口访问任意后端（listPrinters / getCapabilities / getStatus / submitJob / getJobStatus / cancelJob），平台差异全部隔离在后端层；可用性与平台信息均由运行时探测动态生成（不烘焙开发环境信息）。
            系统打印机自动发现：启动即同步 + 每 60s 周期同步（Windows 打印栈 / CUPS，幂等去重）。
            {devMode ? '' : '当前为正式运行模式：无任何虚拟设备。'}
          </p>
        </CardContent>
      </Card>

      {/* ---------------------------------------------------------------- Virtual IPP Server（仅开发/测试模式显示；正式运行环境无虚拟设备） */}
      {devMode && (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <RadioTower className="size-4 text-muted-foreground" aria-hidden />
            Virtual IPP Server
            <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400">
              开发 / 测试工具
            </Badge>
            {vipp && (
              <Badge variant="secondary" className="font-mono text-[10px]">
                :{vipp.port} · RFC 8010/8011
              </Badge>
            )}
            {vipp?.tlsPort != null && (
              <Badge variant="secondary" className="font-mono text-[10px]">
                TLS :{vipp.tlsPort}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs leading-relaxed text-muted-foreground">
            面向<strong className="text-foreground">开发与测试环境</strong>的本地 IPP 模拟服务——使用真实 IPP 二进制协议（Get-Printer-Attributes / Print-Job / Get-Job-Attributes / Cancel-Job），
            用于在没有实体打印机的 CI/开发环境中验证 IPPPrinterBackend 全链路。四台打印机分别模拟<strong className="text-foreground">不同能力缺失组合</strong>，用于测试能力三态模型。
            （不属于产品功能，生产部署可用 OPS_VIPP_ENABLED=0 关闭）
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
                          {vipp.tlsPort != null && (
                            <Badge variant="outline" className="text-[10px]" title="ipps://（IPP over TLS）加密通道可用">ipps</Badge>
                          )}
                        </div>
                        <div className="mt-0.5 min-w-0 space-y-0.5">
                          <p className="truncate font-mono text-[10px] text-muted-foreground/70" title={`ipp://localhost:${vipp.port}/printers/${p.id}`}>
                            ipp://localhost:{vipp.port}/printers/{p.id}
                          </p>
                          {vipp.tlsPort != null && (
                            <p className="flex min-w-0 items-center gap-1 font-mono text-[10px] text-muted-foreground/70">
                              <Lock className="size-2.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
                              <span className="truncate" title={`ipps://localhost:${vipp.tlsPort}/printers/${p.id}`}>
                                ipps://localhost:{vipp.tlsPort}/printers/{p.id}
                              </span>
                            </p>
                          )}
                        </div>
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
      )}

      {/* ---------------- Virtual PJL Printer（P4 · RAW 9100 仿真；仅开发/测试模式显示） */}
      {devMode && (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <Cable className="size-4 text-muted-foreground" aria-hidden />
            Virtual PJL Printer
            <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400">
              开发 / 测试工具
            </Badge>
            {vpjl && (
              <Badge variant="secondary" className="font-mono text-[10px]">
                :{vpjlPort} · RAW 9100 · HP JetDirect
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs leading-relaxed text-muted-foreground">
            P4 Vendor Adapter 试点——本地 RAW 9100 仿真（HP JetDirect / AppSocket 血统，1992 年 HP 发明、事实上的打印通用端口）。
            在无实体打印机的环境中验证 <strong className="text-foreground">PJL 双向回读</strong>全链路：UEL 包裹的
            <code className="mx-1 rounded bg-muted px-1 py-px font-mono text-[10px]">@PJL INFO STATUS / SUPPLY</code>
            查询 → 状态码映射 / 耗材解析 → 能力报告 VENDOR_API 来源融合。生产部署可用 OPS_VPJL_ENABLED=0 关闭。
          </p>
          {!vpjl ? (
            <EmptyState title="Virtual PJL Printer 未启用" hint="可通过环境变量 OPS_VPJL_ENABLED=0 关闭；默认随 Host 启动（:3067）" />
          ) : (
            <div className="space-y-3">
              <div className="grid gap-2 min-[420px]:grid-cols-3">
                <div className="rounded-lg border bg-muted/30 p-2.5">
                  <p className="text-[10px] text-muted-foreground/70">当前状态（PJL CODE）</p>
                  <p className="mt-1 flex items-center gap-1.5 text-sm font-medium">
                    <span
                      className={cn(
                        'inline-block size-2 shrink-0 rounded-full',
                        vpjl.condition === 'ready' && 'bg-emerald-500',
                        vpjl.condition === 'busy' && 'bg-sky-500 animate-pulse',
                        vpjl.condition === 'warmup' && 'bg-amber-500 animate-pulse',
                        (vpjl.condition === 'offline' || vpjl.condition === 'paper-out' || vpjl.condition === 'paper-jam' || vpjl.condition === 'door-open' || vpjl.condition === 'toner-empty') && 'bg-red-500',
                        vpjl.condition === 'toner-low' && 'bg-amber-500',
                      )}
                      aria-hidden
                    />
                    {PJL_CONDITION_LABEL[vpjl.condition] ?? vpjl.condition}
                    <span className="font-mono text-[10px] text-muted-foreground/70">{PJL_CONDITION_CODE[vpjl.condition] ?? ''}</span>
                  </p>
                </div>
                <div className="rounded-lg border bg-muted/30 p-2.5">
                  <p className="text-[10px] text-muted-foreground/70">RAW 已接收字节（打印数据通道）</p>
                  <p className="mt-1 font-mono text-sm font-medium">{vpjl.rawReceivedBytes.toLocaleString()} B</p>
                </div>
                <div className="rounded-lg border bg-muted/30 p-2.5">
                  <p className="text-[10px] text-muted-foreground/70">连接数 / 模拟页数</p>
                  <p className="mt-1 font-mono text-sm font-medium">
                    {vpjl.connectionCount} / {vpjl.rawPageCount} 页
                  </p>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>注入调试状态（验证 @PJL INFO 回读 → 能力报告 VENDOR_API 融合）</Label>
                <div className="flex flex-wrap gap-1.5">
                  {PJL_CONDITIONS.map((c) => (
                    <button
                      key={c.key}
                      onClick={() => void injectPjl(c.key)}
                      disabled={pjlBusy}
                      className={cn(
                        'rounded-md border px-2 py-1 text-[11px] transition-colors duration-150 disabled:opacity-60',
                        vpjl.condition === c.key
                          ? 'border-primary/40 bg-primary/10 text-foreground'
                          : 'border-border bg-background text-muted-foreground hover:border-primary/30 hover:text-foreground',
                      )}
                      title={c.hint}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground/80">
                验证路径：在
                <button className="mx-0.5 underline decoration-dotted underline-offset-2" onClick={() => goto('pairing')}>设备配对页</button>
                启用「PJL 探测设置」并将端口指向 {vpjlPort}，导入任一 vipp 打印机（backendUri 主机 127.0.0.1）后到
                <button className="mx-0.5 underline decoration-dotted underline-offset-2" onClick={() => goto('printers')}>打印机页</button>
                点「刷新能力」——VENDOR_API 探测记录与耗材融合即来自本设备回读。
                <span className="text-foreground/80">未知 CODE 不映射状态（三态原则：不猜测）。</span>
              </p>
            </div>
          )}
        </CardContent>
      </Card>
      )}

      {/* ---------------- Virtual HP LEDM/CDM Printer（P9 · Vendor Adapter 仿真；仅开发/测试模式显示） */}
      {devMode && (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <Globe className="size-4 text-muted-foreground" aria-hidden />
            Virtual HP LEDM/CDM Printer
            <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400">
              开发 / 测试工具
            </Badge>
            {vledm && (
              <Badge variant="secondary" className="font-mono text-[10px]">
                :{vledmPort} · HTTP · LEDM/CDM
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs leading-relaxed text-muted-foreground">
            P9 Vendor Adapter——本地 HTTP 仿真（HPLIP 3.26.4 源码实证通道：LEDM <span className="font-mono">:8080</span> XML 三文档 +
            CDM <span className="font-mono">:80</span> JSON）。在无实体 HP 打印机的环境中验证
            <strong className="text-foreground"> HP LEDM/CDM 只读探测</strong>全链路：四文档并行 GET → 命名空间剥除解析
            （耗材/纸盒/双面器/状态）→ 能力报告 VENDOR_API 来源融合。生产部署可用 OPS_VLEDM_ENABLED=0 关闭。
          </p>
          {!vledm ? (
            <EmptyState title="Virtual HP LEDM/CDM Printer 未启用" hint="可通过环境变量 OPS_VLEDM_ENABLED=0 关闭；默认随 Host 启动（:3068）" />
          ) : (
            <div className="space-y-3">
              <div className="grid gap-2 min-[420px]:grid-cols-3">
                <div className="rounded-lg border bg-muted/30 p-2.5">
                  <p className="text-[10px] text-muted-foreground/70">当前状态（StatusCategory）</p>
                  <p className="mt-1 flex items-center gap-1.5 text-sm font-medium">
                    <span
                      className={cn(
                        'inline-block size-2 shrink-0 rounded-full',
                        vledm.condition === 'ready' && 'bg-emerald-500',
                        vledm.condition === 'busy' && 'bg-sky-500 animate-pulse',
                        (vledm.condition === 'paper-out' || vledm.condition === 'paper-jam' || vledm.condition === 'door-open' || vledm.condition === 'hard-error' || vledm.condition === 'toner-empty') && 'bg-red-500',
                        vledm.condition === 'toner-low' && 'bg-amber-500',
                      )}
                      aria-hidden
                    />
                    {HP_LEDM_CONDITION_LABEL[vledm.condition] ?? vledm.condition}
                    <span className="font-mono text-[10px] text-muted-foreground/70">{HP_LEDM_CATEGORY[vledm.condition] ?? ''}</span>
                  </p>
                </div>
                <div className="rounded-lg border bg-muted/30 p-2.5">
                  <p className="text-[10px] text-muted-foreground/70">应答风格（宽容解析验证）</p>
                  <p className="mt-1 flex flex-wrap items-center gap-1.5">
                    {(['namespaced', 'bare', '404'] as const).map((s) => (
                      <button
                        key={s}
                        onClick={() => void injectHpStyle(s)}
                        disabled={hpBusy}
                        title={HP_LEDM_STYLE_LABEL[s]}
                        className={cn(
                          'rounded-md border px-2 py-0.5 font-mono text-[11px] transition-colors duration-150 disabled:opacity-60',
                          vledm.style === s
                            ? 'border-primary/40 bg-primary/10 text-foreground'
                            : 'border-border bg-background text-muted-foreground hover:border-primary/30 hover:text-foreground',
                        )}
                      >
                        {s}
                      </button>
                    ))}
                  </p>
                </div>
                <div className="rounded-lg border bg-muted/30 p-2.5">
                  <p className="text-[10px] text-muted-foreground/70">累计 HTTP 请求数</p>
                  <p className="mt-1 font-mono text-sm font-medium">{vledm.requestCount.toLocaleString()}</p>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>注入调试状态（验证 LEDM StatusCategory 回读 → 能力报告 VENDOR_API 融合）</Label>
                <div className="flex flex-wrap gap-1.5">
                  {HP_LEDM_CONDITIONS.map((c) => (
                    <button
                      key={c.key}
                      onClick={() => void injectHpLedm(c.key)}
                      disabled={hpBusy}
                      className={cn(
                        'rounded-md border px-2 py-1 text-[11px] transition-colors duration-150 disabled:opacity-60',
                        vledm.condition === c.key
                          ? 'border-primary/40 bg-primary/10 text-foreground'
                          : 'border-border bg-background text-muted-foreground hover:border-primary/30 hover:text-foreground',
                      )}
                      title={c.hint}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground/80">
                验证路径：在
                <button className="mx-0.5 underline decoration-dotted underline-offset-2" onClick={() => goto('pairing')}>设备配对页</button>
                启用「HP LEDM/CDM 探测设置」并将 LEDM/CDM 端口均指向 {vledmPort}，导入任一 vipp 打印机（backendUri 主机 127.0.0.1）后到
                <button className="mx-0.5 underline decoration-dotted underline-offset-2" onClick={() => goto('printers')}>打印机页</button>
                点「刷新能力」——VENDOR_API 探测记录、四色墨耗材融合、纸盒（Tray1/Tray2/PhotoTray）与双面器即来自本设备回读。
                <span className="text-foreground/80">404 风格验证 UNKNOWN 兜底（读不到≠不支持）；未知 StatusCategory 不映射状态（三态原则）。</span>
              </p>
            </div>
          )}
        </CardContent>
      </Card>
      )}

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
              {mdnsPrinters.map((p) => {
                const pdls = (p.txt?.pdl ?? '').split(',').map((s) => s.trim())
                const driverless = pdls.includes('application/pdf') || pdls.includes('image/urf')
                return (
                  <li key={p.uri} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg border p-3 transition-colors duration-200 hover:border-primary/30">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Globe className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                        <span className="truncate text-sm font-medium" title={p.name}>{p.name}</span>
                        <Badge variant="secondary" className="font-mono text-[10px]">{p.ip}:{p.port}</Badge>
                        {driverless && (
                          <Badge
                            variant="outline"
                            className="border-emerald-500/40 bg-emerald-500/10 text-[10px] text-emerald-700 dark:text-emerald-400"
                            title="mDNS TXT pdl 含 application/pdf / image/urf —— 支持 IPP Everywhere / AirPrint 免驱直打（数据来自设备真实通告，非型号猜测）"
                          >
                            IPP Everywhere · 免驱
                          </Badge>
                        )}
                      </div>
                      <div className="mt-0.5 flex min-w-0 items-center gap-1 font-mono text-[10px] text-muted-foreground/70">
                        <span className="truncate" title={p.uri}>{p.uri}</span>
                        {p.uri.startsWith('ipps://') && (
                          <Badge variant="outline" className="shrink-0 gap-0.5 text-[10px] text-emerald-700 dark:text-emerald-400">
                            <Lock className="size-2.5" aria-hidden /> TLS
                          </Badge>
                        )}
                      </div>
                      {p.txt?.ty && <p className="mt-0.5 truncate text-[11px] text-muted-foreground/70">{p.txt.ty}{p.txt.note ? ` · ${p.txt.note}` : ''}</p>}
                    </div>
                    <Button size="sm" variant="outline" disabled={busyKeys.includes(p.uri)} onClick={() => void importFromMdns(p)}>
                      <Link2 className="size-3.5" aria-hidden />
                      添加
                    </Button>
                  </li>
                )
              })}
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
            <Label htmlFor="ipp-uri">IPP URI（ipp:// 或 ipps://）</Label>
            <div className="flex gap-2">
              <Input
                id="ipp-uri"
                value={uri}
                onChange={(e) => setUri(e.target.value)}
                placeholder="ipp://192.168.1.50/ipp/print 或 ipps://…"
                className="min-w-0 flex-1 font-mono text-xs"
                inputMode="url"
              />
              <Button onClick={() => void addUri()} disabled={adding} className="shrink-0">
                {adding ? <RefreshCw className="size-3.5 animate-spin" aria-hidden /> : <FileDown className="size-3.5" aria-hidden />}
                添加并探测
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground/60">ipps:// 走 TLS 加密（自签名证书自动容忍）</p>
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
