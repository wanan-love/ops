'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { BadgeCheck, Cable, Copy, Eye, EyeOff, Fingerprint, Globe, KeyRound, Link2, Link2Off, Loader2, Lock, LockOpen, MonitorSmartphone, Radio, RefreshCcw, ShieldCheck, ShieldOff, Smartphone, Tablet } from 'lucide-react'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useOpsClient, useOpsStore } from './store'
import { useConsoleToken, useDevice, usePairedToken, useUpdatePairedToken } from '@/lib/ops/hooks'
import { formatTime } from './widgets'
import type { Platform } from '@/lib/ops/types'

const PLATFORM_ICON: Record<Platform, React.ReactNode> = {
  windows: <MonitorSmartphone className="size-4" aria-hidden />,
  macos: <MonitorSmartphone className="size-4" aria-hidden />,
  linux: <MonitorSmartphone className="size-4" aria-hidden />,
  android: <Smartphone className="size-4" aria-hidden />,
  ios: <Tablet className="size-4" aria-hidden />,
  web: <MonitorSmartphone className="size-4" aria-hidden />,
}

export function PairingView() {
  const client = useOpsClient()
  const settings = useOpsStore((s) => s.settings)
  const requests = useOpsStore((s) => s.pairingRequests)
  const devices = useOpsStore((s) => s.devices)
  const refresh = useOpsStore((s) => s.refresh)
  const consoleEnableAuth = useOpsStore((s) => s.consoleEnableAuth)
  const consoleDisableAuth = useOpsStore((s) => s.consoleDisableAuth)
  const consoleRegenerate = useOpsStore((s) => s.consoleRegenerate)
  const consoleLogout = useOpsStore((s) => s.consoleLogout)
  const device = useDevice()
  const myToken = usePairedToken()
  const updateToken = useUpdatePairedToken()
  const savedConsoleToken = useConsoleToken()
  const [requesting, setRequesting] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const consoleAuthOn = settings?.consoleAuth?.enabled === true
  // 服务器侧令牌（已授权时 settings 会返回完整值）；未授权时退回本端保存值（仅长度/前缀展示用）
  const serverToken = settings?.consoleAuth?.token ?? null
  const displayToken = serverToken ?? savedConsoleToken

  const [tokenReveal, setTokenReveal] = useState(false)
  const [enableBusy, setEnableBusy] = useState(false)
  const [disableBusy, setDisableBusy] = useState(false)
  const [regenBusy, setRegenBusy] = useState(false)
  const [freshToken, setFreshToken] = useState<string | null>(null)

  const copyToken = useCallback(async (token: string) => {
    try {
      await navigator.clipboard.writeText(token)
      toast.success('令牌已复制到剪贴板')
    } catch {
      toast.error('复制失败', { description: '请手动选中文本复制' })
    }
  }, [])

  const enableConsoleAuth = useCallback(async () => {
    setEnableBusy(true)
    try {
      const token = await consoleEnableAuth()
      setFreshToken(token)
      setTokenReveal(true)
      toast.success('控制台鉴权已启用', {
        description: `令牌已生成并保存在本端（${token.slice(0, 12)}…）；完整值同步落盘 data/console-token.txt`,
      })
    } catch (e) {
      toast.error('启用失败', { description: (e as Error).message })
    } finally {
      setEnableBusy(false)
    }
  }, [consoleEnableAuth])

  const disableConsoleAuth = useCallback(async () => {
    setDisableBusy(true)
    try {
      await consoleDisableAuth()
      setFreshToken(null)
      setTokenReveal(false)
      toast.info('控制台鉴权已关闭', { description: '局域网管理面恢复开放（本端保存的令牌已失效）' })
    } catch (e) {
      toast.error('关闭失败', { description: (e as Error).message })
    } finally {
      setDisableBusy(false)
    }
  }, [consoleDisableAuth])

  const regenerateConsoleToken = useCallback(async () => {
    setRegenBusy(true)
    try {
      const token = await consoleRegenerate()
      setFreshToken(token)
      setTokenReveal(true)
      toast.success('令牌已重新生成', { description: `旧令牌立即失效，新令牌已保存（${token.slice(0, 12)}…）` })
    } catch (e) {
      toast.error('重生成失败', { description: (e as Error).message })
    } finally {
      setRegenBusy(false)
    }
  }, [consoleRegenerate])

  const pendingRequests = requests.filter((r) => r.status === 'pending')

  // 设备侧：等待 Host 审批（轮询自己的请求状态，批准后领取令牌）
  useEffect(() => {
    if (!requesting) return
    pollRef.current = setInterval(async () => {
      try {
        const status = await client.pairingStatus(device.deviceId)
        if (status.paired && status.token && status.token !== myToken) {
          updateToken(status.token)
          setRequesting(false)
          toast.success('配对成功！', { description: '设备令牌已保存，安全模式下可提交打印' })
          await refresh()
        } else if (status.pending.length === 0 && !status.paired) {
          setRequesting(false)
        }
      } catch {
        /* keep polling */
      }
    }, 2000)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [requesting, device, client, myToken, refresh, updateToken])

  const requestPairing = useCallback(async () => {
    setRequesting(true)
    try {
      await client.requestPairing({ deviceId: device.deviceId, deviceName: device.deviceName, platform: 'web' })
      toast.info('配对请求已发送', { description: '请在下方「待审批请求」中批准本设备' })
    } catch (e) {
      setRequesting(false)
      toast.error('请求失败', { description: (e as Error).message })
    }
  }, [client, device])

  const approve = async (id: string) => {
    try {
      const r = await client.approvePairing(id)
      toast.success('设备已配对', { description: `令牌已生成（${r.token.slice(0, 12)}…），设备侧将自动领取` })
    } catch (e) {
      toast.error('审批失败', { description: (e as Error).message })
    }
  }

  const reject = async (id: string) => {
    try {
      await client.rejectPairing(id)
      toast.info('已拒绝配对请求')
    } catch (e) {
      toast.error('操作失败', { description: (e as Error).message })
    }
  }

  const revoke = async (deviceId: string) => {
    try {
      await client.revokeDevice(deviceId)
      if (device.deviceId === deviceId) {
        updateToken(null)
      }
      toast.success('已解除配对')
    } catch (e) {
      toast.error('解除失败', { description: (e as Error).message })
    }
  }

  const toggleSecurity = async (pairing: boolean) => {
    try {
      await client.updateSettings({ securityMode: pairing ? 'pairing' : 'open' })
      await refresh()
      toast.success(`安全模式已切换为「${pairing ? '配对' : '开放'}」`, {
        description: pairing ? '未配对设备将无法提交打印任务' : '局域网内设备可直接打印',
      })
    } catch (e) {
      toast.error('设置失败', { description: (e as Error).message })
    }
  }

  // SNMP community（耗材/状态探测；企业机型常改非默认值，见 docs/VENDOR_PROTOCOLS.md P1）
  const [snmpDraft, setSnmpDraft] = useState('')
  const [snmpDirty, setSnmpDirty] = useState(false)
  const [snmpSaving, setSnmpSaving] = useState(false)
  useEffect(() => {
    if (!snmpDirty && settings) setSnmpDraft(settings.snmpCommunity ?? 'public')
  }, [settings, snmpDirty])

  const saveSnmpCommunity = async () => {
    const trimmed = snmpDraft.trim()
    if (!/^\S{1,64}$/.test(trimmed)) {
      toast.error('SNMP community 无效', { description: '需为 1-64 个非空白字符（默认 public）' })
      return
    }
    setSnmpSaving(true)
    try {
      await client.updateSettings({ snmpCommunity: trimmed })
      setSnmpDirty(false)
      await refresh()
      toast.success('SNMP community 已保存', { description: '下次「刷新能力」时生效（耗材/状态探测共用）' })
    } catch (e) {
      toast.error('保存失败', { description: (e as Error).message })
    } finally {
      setSnmpSaving(false)
    }
  }

  // PJL over RAW 9100 双向探测（P4 Vendor Adapter 试点；默认关闭需显式启用，见 VENDOR_PROTOCOLS.md 安全默认）
  const [pjlPortDraft, setPjlPortDraft] = useState('')
  const [pjlPortDirty, setPjlPortDirty] = useState(false)
  const [pjlPortSaving, setPjlPortSaving] = useState(false)
  const [pjlToggling, setPjlToggling] = useState(false)
  useEffect(() => {
    if (!pjlPortDirty && settings) setPjlPortDraft(String(settings.pjlPort ?? 9100))
  }, [settings, pjlPortDirty])

  const togglePjlProbe = async (enabled: boolean) => {
    setPjlToggling(true)
    try {
      await client.updateSettings({ pjlProbeEnabled: enabled })
      await refresh()
      toast.success(enabled ? 'PJL 探测已启用' : 'PJL 探测已关闭', {
        description: enabled
          ? '下次「刷新能力」时将向打印机 RAW 端口发送 @PJL INFO 查询（IPP → SNMP → PJL 兜底）'
          : 'VENDOR_API 来源不再探测（安全默认）',
      })
    } catch (e) {
      toast.error('设置失败', { description: (e as Error).message })
    } finally {
      setPjlToggling(false)
    }
  }

  const savePjlPort = async () => {
    const n = Number(pjlPortDraft.trim())
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      toast.error('PJL 端口无效', { description: '需为 1-65535 整数（真实设备通用 9100）' })
      return
    }
    setPjlPortSaving(true)
    try {
      await client.updateSettings({ pjlPort: n })
      setPjlPortDirty(false)
      await refresh()
      toast.success('PJL 探测端口已保存', { description: `下次「刷新能力」时连接 ${n} 端口（真实设备通用 9100）` })
    } catch (e) {
      toast.error('保存失败', { description: (e as Error).message })
    } finally {
      setPjlPortSaving(false)
    }
  }

  // HP LEDM/CDM 双向探测（P9 Vendor Adapter；HPLIP 源码实证通道，默认关闭需显式启用）
  const [hpLedmPortDraft, setHpLedmPortDraft] = useState('')
  const [hpLedmPortDirty, setHpLedmPortDirty] = useState(false)
  const [hpLedmPortSaving, setHpLedmPortSaving] = useState(false)
  const [hpCdmPortDraft, setHpCdmPortDraft] = useState('')
  const [hpCdmPortDirty, setHpCdmPortDirty] = useState(false)
  const [hpCdmPortSaving, setHpCdmPortSaving] = useState(false)
  const [hpToggling, setHpToggling] = useState(false)
  useEffect(() => {
    if (!hpLedmPortDirty && settings) setHpLedmPortDraft(String(settings.hpLedmPort ?? 8080))
    if (!hpCdmPortDirty && settings) setHpCdmPortDraft(String(settings.hpCdmPort ?? 80))
  }, [settings, hpLedmPortDirty, hpCdmPortDirty])

  const toggleHpLedmProbe = async (enabled: boolean) => {
    setHpToggling(true)
    try {
      await client.updateSettings({ hpLedmProbeEnabled: enabled })
      await refresh()
      toast.success(enabled ? 'HP LEDM/CDM 探测已启用' : 'HP LEDM/CDM 探测已关闭', {
        description: enabled
          ? '下次「刷新能力」时将向打印机 LEDM（:8080）与 CDM（:80）端点发起 HTTP 探测（IPP → SNMP → PJL → HP 兕底）'
          : 'VENDOR_API 来源不再探测 HP 通道（安全默认）',
      })
    } catch (e) {
      toast.error('设置失败', { description: (e as Error).message })
    } finally {
      setHpToggling(false)
    }
  }

  const saveHpLedmPort = async () => {
    const n = Number(hpLedmPortDraft.trim())
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      toast.error('LEDM 端口无效', { description: '需为 1-65535 整数（真实 HP 8080）' })
      return
    }
    setHpLedmPortSaving(true)
    try {
      await client.updateSettings({ hpLedmPort: n })
      setHpLedmPortDirty(false)
      await refresh()
      toast.success('LEDM 端口已保存', { description: `下次「刷新能力」时请求 http://打印机:${n}/DevMgmt/*.xml（真实 HP 8080）` })
    } catch (e) {
      toast.error('保存失败', { description: (e as Error).message })
    } finally {
      setHpLedmPortSaving(false)
    }
  }

  const saveHpCdmPort = async () => {
    const n = Number(hpCdmPortDraft.trim())
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      toast.error('CDM 端口无效', { description: '需为 1-65535 整数（真实 HP 80）' })
      return
    }
    setHpCdmPortSaving(true)
    try {
      await client.updateSettings({ hpCdmPort: n })
      setHpCdmPortDirty(false)
      await refresh()
      toast.success('CDM 端口已保存', { description: `下次「刷新能力」时请求 http://打印机:${n}/cdm/supply/v1/suppliesPublic（真实 HP 80）` })
    } catch (e) {
      toast.error('保存失败', { description: (e as Error).message })
    } finally {
      setHpCdmPortSaving(false)
    }
  }

  const myRequestPending = requesting || pendingRequests.some((r) => r.deviceId === device.deviceId)

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="min-w-0">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              {settings?.securityMode === 'pairing' ? <ShieldCheck className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden /> : <ShieldOff className="size-4 text-muted-foreground" aria-hidden />}
              Host 安全模式
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between rounded-md border px-3 py-2.5">
              <div>
                <Label htmlFor="security-mode" className="cursor-pointer">
                  {settings?.securityMode === 'pairing' ? '配对模式（需设备令牌）' : '开放模式（局域网信任）'}
                </Label>
                <p className="text-[11px] text-muted-foreground/70">
                  {settings?.securityMode === 'pairing' ? '提交打印必须携带 X-OPS-Token' : 'MVP 默认：便于演示，生产建议开启配对'}
                </p>
              </div>
              <Switch id="security-mode" checked={settings?.securityMode === 'pairing'} onCheckedChange={toggleSecurity} />
            </div>
            <div className="flex items-center gap-2 rounded-md border bg-muted/20 p-3 font-mono text-[11px] text-muted-foreground shadow-xs">
              <KeyRound className="size-3.5 shrink-0" aria-hidden />
              已配对设备 {devices.length} 台 · 待审批 {pendingRequests.length} 条
            </div>
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Fingerprint className="size-4 text-muted-foreground" aria-hidden />
              本设备（Client 视角）
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="rounded-md border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium">{device.deviceName || '—'}</p>
                  <p className="font-mono text-[11px] text-muted-foreground">{device.deviceId.slice(0, 18)}…</p>
                </div>
                {myToken ? (
                  <Badge variant="outline" className="gap-1 border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
                    <BadgeCheck className="size-3" aria-hidden />
                    已配对
                  </Badge>
                ) : (
                  <Badge variant="outline" className="gap-1 text-muted-foreground">
                    <Link2Off className="size-3" aria-hidden />
                    未配对
                  </Badge>
                )}
              </div>
              {myToken && <p className="mt-2 font-mono text-[10px] text-muted-foreground/70">token: {myToken.slice(0, 16)}…（localStorage）</p>}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={requestPairing} disabled={myRequestPending}>
                <Link2 className="size-3.5" aria-hidden />
                {myRequestPending ? '等待 Host 审批…' : '请求配对'}
              </Button>
              {myToken && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    updateToken(null)
                    toast.info('已清除本设备令牌')
                  }}
                >
                  清除令牌
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="min-w-0">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Radio className="size-4 text-muted-foreground" aria-hidden />
            SNMP 探测设置（Host）
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="snmp-community">community 字符串（v1/v2c，用于墨量 / 缺纸 / 卡纸探测）</Label>
            <div className="flex gap-2">
              <Input
                id="snmp-community"
                value={snmpDraft}
                onChange={(e) => {
                  setSnmpDraft(e.target.value)
                  setSnmpDirty(true)
                }}
                placeholder="public"
                className="min-w-0 flex-1 font-mono text-xs"
                autoComplete="off"
                spellCheck={false}
              />
              <Button className="shrink-0" onClick={() => void saveSnmpCommunity()} disabled={snmpSaving || !snmpDirty || snmpDraft.trim() === (settings?.snmpCommunity ?? 'public')}>
                {snmpSaving ? '保存中…' : '保存'}
              </Button>
            </div>
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground/70">
            企业级打印机（Ricoh / Kyocera / KM / Xerox 等）常将 SNMP community 改为非默认值；修改后到打印机页「刷新能力」即可用新值重试探测。
            读取不到时墨量显示 UNKNOWN（不代表不支持），详见故障排查文档。
          </p>
        </CardContent>
      </Card>

      <Card className="min-w-0">
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <Cable className="size-4 text-muted-foreground" aria-hidden />
            PJL 探测设置（RAW 9100）
            {settings?.pjlProbeEnabled === true ? (
              <Badge variant="outline" className="gap-1 border-emerald-500/40 bg-emerald-500/10 text-[10px] text-emerald-700 dark:text-emerald-400">
                <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden />
                已启用
              </Badge>
            ) : (
              <Badge variant="outline" className="gap-1 text-[10px] text-muted-foreground">
                <span className="size-1.5 rounded-full bg-zinc-400" aria-hidden />
                默认关闭
              </Badge>
            )}
            <Badge variant="secondary" className="font-mono text-[10px]">P4 · Vendor Adapter 试点</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between rounded-md border px-3 py-2.5">
            <div className="min-w-0">
              <Label htmlFor="pjl-probe" className="cursor-pointer">
                启用 PJL 双向回读（@PJL INFO 状态 / 耗材）
              </Label>
              <p className="mt-0.5 text-[11px] text-muted-foreground/70">
                向打印机 RAW 端口发送查询（连接即发、超时 900ms）
              </p>
            </div>
            <Switch
              id="pjl-probe"
              checked={settings?.pjlProbeEnabled === true}
              onCheckedChange={(v) => void togglePjlProbe(v)}
              disabled={pjlToggling}
              aria-label="启用 PJL over RAW 9100 探测"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pjl-port">RAW 端口（真实设备通用 9100）</Label>
            <div className="flex gap-2">
              <Input
                id="pjl-port"
                value={pjlPortDraft}
                onChange={(e) => {
                  setPjlPortDraft(e.target.value.replace(/\D/g, '').slice(0, 5))
                  setPjlPortDirty(true)
                }}
                inputMode="numeric"
                placeholder="9100"
                className="min-w-0 flex-1 font-mono text-xs"
                autoComplete="off"
                spellCheck={false}
              />
              <Button className="shrink-0" onClick={() => void savePjlPort()} disabled={pjlPortSaving || !pjlPortDirty || Number(pjlPortDraft) === (settings?.pjlPort ?? 9100)}>
                {pjlPortSaving ? '保存中…' : '保存'}
              </Button>
            </div>
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground/80">
            Brother / HP 等品牌的消费级机型 SNMP 常缺失/禁用，但 RAW 9100（1992 年 HP JetDirect 发明、事实上的打印通用端口）是双向字节流，
            可用 <code className="rounded bg-muted px-1 py-px font-mono text-[10px]">@PJL INFO STATUS / SUPPLY</code> 回读状态与耗材。
            通道优先级 <code className="rounded bg-muted px-1 py-px font-mono text-[10px]">IPP → SNMP → PJL</code>（仅在前面来源未读到时补充；CODE 无法映射的未知状态不猜测）。
            默认关闭是安全默认（避免与在用打印通道互扰）；<span className="text-foreground/80">@PJL INFO SUPPLY 为 Brother 风格试点格式，真实机型响应需抓包适配</span>。
          </p>
        </CardContent>
      </Card>

      <Card className="min-w-0">
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <Globe className="size-4 text-muted-foreground" aria-hidden />
            HP LEDM/CDM 探测设置（HTTP）
            {settings?.hpLedmProbeEnabled === true ? (
              <Badge variant="outline" className="gap-1 border-emerald-500/40 bg-emerald-500/10 text-[10px] text-emerald-700 dark:text-emerald-400">
                <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden />
                已启用
              </Badge>
            ) : (
              <Badge variant="outline" className="gap-1 text-[10px] text-muted-foreground">
                <span className="size-1.5 rounded-full bg-zinc-400" aria-hidden />
                默认关闭
              </Badge>
            )}
            <Badge variant="secondary" className="font-mono text-[10px]">P9 · HPLIP 实证通道</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between rounded-md border px-3 py-2.5">
            <div className="min-w-0">
              <Label htmlFor="hp-ledm-probe" className="cursor-pointer">
                启用 HP LEDM/CDM 回读（XML / JSON 耗材 · 纸盒 · 状态）
              </Label>
              <p className="mt-0.5 text-[11px] text-muted-foreground/70">
                向打印机 HTTP 端点发起只读 GET（超时 1200ms，四文档并行）
              </p>
            </div>
            <Switch
              id="hp-ledm-probe"
              checked={settings?.hpLedmProbeEnabled === true}
              onCheckedChange={(v) => void toggleHpLedmProbe(v)}
              disabled={hpToggling}
              aria-label="启用 HP LEDM/CDM 探测"
            />
          </div>
          <div className="grid gap-2 min-[420px]:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="hp-ledm-port">LEDM 端口（真实 HP 8080）</Label>
              <div className="flex gap-2">
                <Input
                  id="hp-ledm-port"
                  value={hpLedmPortDraft}
                  onChange={(e) => {
                    setHpLedmPortDraft(e.target.value.replace(/\D/g, '').slice(0, 5))
                    setHpLedmPortDirty(true)
                  }}
                  inputMode="numeric"
                  placeholder="8080"
                  className="min-w-0 flex-1 font-mono text-xs"
                  autoComplete="off"
                  spellCheck={false}
                />
                <Button className="shrink-0" onClick={() => void saveHpLedmPort()} disabled={hpLedmPortSaving || !hpLedmPortDirty || Number(hpLedmPortDraft) === (settings?.hpLedmPort ?? 8080)}>
                  {hpLedmPortSaving ? '保存中…' : '保存'}
                </Button>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="hp-cdm-port">CDM 端口（真实 HP 80）</Label>
              <div className="flex gap-2">
                <Input
                  id="hp-cdm-port"
                  value={hpCdmPortDraft}
                  onChange={(e) => {
                    setHpCdmPortDraft(e.target.value.replace(/\D/g, '').slice(0, 5))
                    setHpCdmPortDirty(true)
                  }}
                  inputMode="numeric"
                  placeholder="80"
                  className="min-w-0 flex-1 font-mono text-xs"
                  autoComplete="off"
                  spellCheck={false}
                />
                <Button className="shrink-0" onClick={() => void saveHpCdmPort()} disabled={hpCdmPortSaving || !hpCdmPortDirty || Number(hpCdmPortDraft) === (settings?.hpCdmPort ?? 80)}>
                  {hpCdmPortSaving ? '保存中…' : '保存'}
                </Button>
              </div>
            </div>
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground/80">
            HP 官方驱动 HPLIP 源码（v3.26.4 逆向归档）实证的双通道：<code className="rounded bg-muted px-1 py-px font-mono text-[10px]">LEDM :8080</code>
            XML 三文档（<code className="break-words rounded bg-muted px-1 py-px font-mono text-[10px]">/DevMgmt/ProductStatusDyn</code>·<code className="break-words rounded bg-muted px-1 py-px font-mono text-[10px]">ConsumableConfigDyn</code>·<code className="break-words rounded bg-muted px-1 py-px font-mono text-[10px]">MediaHandlingDyn</code>，hpmud/jd.c:507）与
            <code className="rounded bg-muted px-1 py-px font-mono text-[10px]">CDM :80</code> JSON（<code className="break-words rounded bg-muted px-1 py-px font-mono text-[10px]">/cdm/supply/v1/suppliesPublic</code>）。
            可回读<strong className="text-foreground">耗材余量（逐色墨盒）、纸盒列表、自动双面器、状态类别</strong>——通道优先级
            <code className="rounded bg-muted px-1 py-px font-mono text-[10px]">IPP → SNMP → PJL → HP</code>；探测失败/404/字段缺失一律 UNKNOWN（读不到≠不支持）。
            <span className="text-foreground/80">XML 响应格式对齐 HPLIP 解析路径；真实机型的响应细节仍以实测为准（解析宽容，未知类别不猜测）。</span>
          </p>
        </CardContent>
      </Card>

      <Card className="min-w-0">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            {consoleAuthOn ? <Lock className="size-4 text-amber-600 dark:text-amber-400" aria-hidden /> : <LockOpen className="size-4 text-muted-foreground" aria-hidden />}
            控制台访问控制
            {consoleAuthOn ? (
              <Badge variant="outline" className="gap-1 border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-700 dark:text-amber-400">
                <span className="size-1.5 rounded-full bg-amber-500" aria-hidden />
                已启用
              </Badge>
            ) : (
              <Badge variant="outline" className="gap-1 text-[10px] text-muted-foreground">
                <span className="size-1.5 rounded-full bg-zinc-400" aria-hidden />
                未启用
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="rounded-md border bg-muted/20 p-3">
            <p className="text-xs leading-relaxed text-muted-foreground">
              {consoleAuthOn
                ? 'REST 管理接口与实时通道需要访问令牌；设备打印 / 配对轴不受影响。协议仿真端口（IPP :3061 / eSCL :3065）保持开放以兼容真实客户端。'
                : '启用后，局域网内未经授权的设备将无法查看/控制管理面（打印机配置、任务队列、扫描、测试等）。与上面的「设备配对」相互独立、可叠加使用。'}
            </p>
          </div>

          {consoleAuthOn ? (
            <>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-xs text-muted-foreground">当前访问令牌{serverToken ? '' : '（服务器返回完整值需已授权）'}</Label>
                  <div className="flex items-center gap-1">
                    {displayToken && (
                      <>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 gap-1 px-2 text-[11px] text-muted-foreground"
                          onClick={() => setTokenReveal((v) => !v)}
                          aria-label={tokenReveal ? '隐藏令牌' : '显示令牌'}
                        >
                          {tokenReveal ? <EyeOff className="size-3" aria-hidden /> : <Eye className="size-3" aria-hidden />}
                          {tokenReveal ? '隐藏' : '显示'}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 gap-1 px-2 text-[11px] text-muted-foreground"
                          onClick={() => void copyToken(displayToken)}
                          aria-label="复制令牌"
                        >
                          <Copy className="size-3" aria-hidden />
                          复制
                        </Button>
                      </>
                    )}
                  </div>
                </div>
                {displayToken ? (
                  <div className="flex min-h-10 items-center gap-2 overflow-x-auto rounded-md border border-dashed bg-muted/30 px-3 py-2 font-mono text-xs">
                    {tokenReveal ? (
                      <span className="tracking-wide break-all">{displayToken}</span>
                    ) : (
                      <span className="tracking-widest text-muted-foreground">{'•'.repeat(Math.min(displayToken.length, 44))}</span>
                    )}
                  </div>
                ) : (
                  <p className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">本端未保存令牌（在其它设备上启用或已重生成）</p>
                )}
              </div>

              {freshToken && (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3" role="status">
                  <p className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                    <ShieldCheck className="size-3.5 shrink-0" aria-hidden />
                    新令牌已生成并自动保存到本端
                  </p>
                  <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                    完整值同步落盘 Host 数据目录 <code className="rounded bg-muted px-1 font-mono text-[10px]">console-token.txt</code>（权限 0600），遗忘时可从该文件恢复。
                  </p>
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="outline" size="sm" disabled={regenBusy}>
                      {regenBusy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <RefreshCcw className="size-3.5" aria-hidden />}
                      重新生成令牌
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>重新生成访问令牌？</AlertDialogTitle>
                      <AlertDialogDescription>
                        当前令牌立即失效，所有已保存该令牌的设备（含本控制台以外的浏览器）需要更新为新值。本端会自动保存新令牌。
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>取消</AlertDialogCancel>
                      <AlertDialogAction onClick={() => void regenerateConsoleToken()}>确认重生成</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>

                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="outline" size="sm" className="text-destructive hover:bg-destructive/10 hover:text-destructive" disabled={disableBusy}>
                      {disableBusy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <LockOpen className="size-3.5" aria-hidden />}
                      关闭鉴权
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>关闭控制台鉴权？</AlertDialogTitle>
                      <AlertDialogDescription>
                        局域网管理面将恢复开放（任何设备可查看/控制）。本端保存的令牌将失效并被清除。
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>取消</AlertDialogCancel>
                      <AlertDialogAction onClick={() => void disableConsoleAuth()}>确认关闭</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>

                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  onClick={() => {
                    consoleLogout()
                    toast.info('已清除本端保存的令牌', { description: '解锁界面将重新出现（可重新输入令牌验证）' })
                  }}
                >
                  <Link2Off className="size-3.5" aria-hidden />
                  清除本端令牌
                </Button>
              </div>

              <div className="rounded-md border border-l-2 border-l-primary/40 bg-muted/20 p-3" role="note" aria-label="API 调用示例（只读）">
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <span className="text-[10px] font-medium tracking-wide text-muted-foreground/70">API 调用示例（只读）</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 gap-1 px-1.5 text-[10px] text-muted-foreground"
                    onClick={async () => {
                      const cmd = `curl -H "x-ops-console-token: ${displayToken ?? '<token>'}" http://{host}:3001/api/printers`
                      try {
                        await navigator.clipboard.writeText(cmd)
                        toast.success('curl 命令已复制')
                      } catch {
                        toast.error('复制失败', { description: '请手动选中文本复制' })
                      }
                    }}
                    aria-label="复制完整 curl 命令"
                  >
                    <Copy className="size-3" aria-hidden />
                    复制命令
                  </Button>
                </div>
                <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[10px] leading-relaxed text-muted-foreground/90">
                  {`curl -H "x-ops-console-token: ${displayToken ?? '<token>'}" \\\n  http://{host}:3001/api/printers`}
                </pre>
                <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground/60">
                  兼容通道：Authorization: Bearer &lt;token&gt; / ?opsToken=（图片与下载链接）
                </p>
              </div>
            </>
          ) : (
            <div className="space-y-3">
              <p className="text-[11px] leading-relaxed text-muted-foreground/70">
                启用动作本身永远开放（收紧无门槛）：生成全新 ops_ 令牌（192-bit）、自动保存到本端、并落盘 Host 数据目录防锁定。
                关闭与重生成则必须持有效令牌。建议生产环境：控制台鉴权 + 设备配对双开。
              </p>
              <Button size="sm" onClick={() => void enableConsoleAuth()} disabled={enableBusy}>
                {enableBusy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Lock className="size-3.5" aria-hidden />}
                启用控制台鉴权
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">待审批请求（Host 控制台）</CardTitle>
        </CardHeader>
        <CardContent>
          {pendingRequests.length === 0 ? (
            <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
              暂无待审批请求。可在右侧「本设备」卡片点击「请求配对」体验完整流程。
            </p>
          ) : (
            <ul className="space-y-2">
              {pendingRequests.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 transition-colors duration-200 hover:border-primary/30">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      {PLATFORM_ICON[r.platform] ?? PLATFORM_ICON.web}
                      <span className="truncate">{r.deviceName}</span>
                      <span className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[11px] font-semibold tracking-widest text-primary">{r.code}</span>
                    </div>
                    <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                      {r.deviceId.slice(0, 16)}… · {formatTime(r.createdAt)}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => approve(r.id)}>
                      批准
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => reject(r.id)}>
                      拒绝
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">已配对设备</CardTitle>
        </CardHeader>
        <CardContent>
          {devices.length === 0 ? (
            <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">暂无已配对设备</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>设备</TableHead>
                  <TableHead className="w-24">平台</TableHead>
                  <TableHead className="w-40">配对时间</TableHead>
                  <TableHead className="w-40">最近活跃</TableHead>
                  <TableHead className="w-20 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {devices.map((d) => (
                  <TableRow key={d.deviceId}>
                    <TableCell className="max-w-56">
                      <p className="truncate text-sm font-medium">{d.name}</p>
                      <p className="font-mono text-[10px] text-muted-foreground">{d.deviceId.slice(0, 16)}…</p>
                    </TableCell>
                    <TableCell className="text-xs">{PLATFORM_ICON[d.platform] ?? PLATFORM_ICON.web} {d.platform}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatTime(d.pairedAt)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatTime(d.lastSeenAt)}</TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="ghost" className="h-8 text-muted-foreground hover:text-destructive" onClick={() => revoke(d.deviceId)} aria-label={`解除 ${d.name}`}>
                        <Link2Off className="size-3.5" aria-hidden />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
