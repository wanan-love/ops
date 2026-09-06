'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { BadgeCheck, Fingerprint, KeyRound, Link2, Link2Off, MonitorSmartphone, ShieldCheck, ShieldOff, Smartphone, Tablet } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useOpsClient, useOpsStore } from './store'
import { useDevice, usePairedToken, useUpdatePairedToken } from '@/lib/ops/hooks'
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
  const device = useDevice()
  const myToken = usePairedToken()
  const updateToken = useUpdatePairedToken()
  const [requesting, setRequesting] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

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
      toast.success(`安全模式已切换为「${pairing ? '配对' : '开放'}」`, {
        description: pairing ? '未配对设备将无法提交打印任务' : '局域网内设备可直接打印',
      })
    } catch (e) {
      toast.error('设置失败', { description: (e as Error).message })
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
