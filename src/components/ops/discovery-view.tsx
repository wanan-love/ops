'use client'

import { useCallback, useState } from 'react'
import { CheckCircle2, MonitorSmartphone, Plug, Radar, RefreshCw, ScanSearch, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useOpsClient, useOpsStore } from './store'
import { useDevice, useSavedHosts, useUpdateDeviceName, useConsoleToken, removeSavedHost, upsertSavedHost, type SavedHost } from '@/lib/ops/hooks'
import { createOpsClient } from '@/lib/ops/client'
import { formatTime } from './widgets'

export function DiscoveryView() {
  const client = useOpsClient()
  const hosts = useOpsStore((s) => s.hosts)
  const hostInfo = useOpsStore((s) => s.hostInfo)
  const restPort = useOpsStore((s) => s.restPort)
  const connected = useOpsStore((s) => s.connected)
  const setRestPort = useOpsStore((s) => s.setRestPort)
  const refresh = useOpsStore((s) => s.refresh)

  const [scanning, setScanning] = useState(false)
  const [manualPort, setManualPort] = useState('3001')
  const [manualChecking, setManualChecking] = useState(false)
  const savedHosts = useSavedHosts()
  const device = useDevice()
  const consoleToken = useConsoleToken()
  const updateDeviceName = useUpdateDeviceName()
  const [deviceName, setDeviceName] = useState<string | null>(null)
  const nameValue = deviceName ?? device.deviceName

  const scan = useCallback(async () => {
    setScanning(true)
    try {
      await client.announce()
      await refresh()
      toast.success('扫描完成', { description: '已发现局域网内的 OpenPrintShare Host' })
    } catch {
      toast.error('扫描失败', { description: '无法访问 Host 服务' })
    } finally {
      setScanning(false)
    }
  }, [client, refresh])

  const addManual = useCallback(async () => {
    const port = parseInt(manualPort, 10)
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      toast.error('端口无效', { description: '请输入 1–65535 之间的端口号（Host REST 端口，默认 3001）' })
      return
    }
    setManualChecking(true)
    try {
      const probe = createOpsClient(port)
      const info = await probe.systemInfo()
      upsertSavedHost({ restPort: port, name: info.hostName, addedAt: new Date().toISOString() })
      toast.success('主机已添加', { description: `${info.hostName}（:${port}）` })
    } catch {
      toast.error('连接失败', { description: `端口 ${port} 上没有发现 OPS Host` })
    } finally {
      setManualChecking(false)
    }
  }, [manualPort])

  const connectHost = useCallback(
    async (port: number) => {
      setRestPort(port)
      setTimeout(() => {
        void refresh()
      }, 50)
      toast.info('正在切换主机', { description: `REST :${port} / Realtime :${port + 1}` })
    },
    [setRestPort, refresh],
  )

  const removeSaved = (port: number) => {
    removeSavedHost(port)
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex-row items-center justify-between pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Radar className="size-4 text-muted-foreground" aria-hidden />
            自动发现（Discovery）
          </CardTitle>
          <Button size="sm" onClick={scan} disabled={scanning}>
            {scanning ? <RefreshCw className="size-3.5 animate-spin" aria-hidden /> : <ScanSearch className="size-3.5" aria-hidden />}
            扫描局域网
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {hosts.map((h) => {
            const isCurrent = h.restPort === restPort && connected
            return (
              <div
                key={`${h.hostId}-${h.restPort}`}
                className={
                  'flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4 transition-colors duration-200 hover:bg-accent/30 ' +
                  (isCurrent ? 'border-emerald-500/40 bg-emerald-500/5' : '')
                }
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{h.hostName}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">:{h.restPort}</span>
                    {isCurrent && (
                      <span className="flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                        <CheckCircle2 className="size-3.5" aria-hidden /> 当前连接
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {h.printers} 台打印机（{h.sharedPrinters} 台已共享） · v{h.version} · OPS/{h.apiVersion} · {h.platform} · {formatTime(h.lastSeenAt)}
                  </p>
                </div>
                <Button size="sm" variant={isCurrent ? 'secondary' : 'default'} onClick={() => connectHost(h.restPort)} disabled={isCurrent}>
                  <Plug className="size-3.5" aria-hidden />
                  {isCurrent ? '已连接' : '连接'}
                </Button>
              </div>
            )
          })}
          {hosts.length === 0 && <p className="py-4 text-center text-sm text-muted-foreground">点击「扫描局域网」发现 Host</p>}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">手动添加（IP / 端口）</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="manual-port">Host REST 端口（默认 3001，实时端口 = REST + 1）</Label>
              <div className="flex gap-2">
                <Input id="manual-port" inputMode="numeric" value={manualPort} onChange={(e) => setManualPort(e.target.value)} placeholder="3001" className="w-32" />
                <Button onClick={addManual} disabled={manualChecking} className="flex-1">
                  {manualChecking ? <RefreshCw className="size-3.5 animate-spin" aria-hidden /> : <Plug className="size-3.5" aria-hidden />}
                  验证并添加
                </Button>
              </div>
            </div>
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">已保存的主机</p>
              {savedHosts.length === 0 ? (
                <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground/70">暂无手动添加的主机</p>
              ) : (
                <ul className="space-y-1.5">
                  {savedHosts.map((h) => (
                    <li key={h.restPort} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm transition-colors duration-200 hover:border-primary/30">
                      <button className="min-w-0 flex-1 text-left hover:underline" onClick={() => connectHost(h.restPort)}>
                        <span className="block truncate font-medium">{h.name}</span>
                        <span className="font-mono text-[10px] text-muted-foreground">:{h.restPort}</span>
                      </button>
                      <Button size="icon" variant="ghost" onClick={() => removeSaved(h.restPort)} aria-label={`删除主机 ${h.name}`} className="size-8">
                        <Trash2 className="size-3.5" aria-hidden />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <MonitorSmartphone className="size-4 text-muted-foreground" aria-hidden />
              本设备身份（Client）
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="device-name">设备名称（打印任务来源显示）</Label>
              <div className="flex gap-2">
                <Input id="device-name" value={nameValue} onChange={(e) => setDeviceName(e.target.value)} placeholder="我的设备" />
                <Button
                  variant="outline"
                  onClick={() => {
                    const next = updateDeviceName(nameValue)
                    setDeviceName(null)
                    toast.success('设备名称已保存', { description: next.deviceName })
                  }}
                >
                  保存
                </Button>
              </div>
            </div>
            <div className="overflow-x-auto rounded-md bg-muted/60 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground [scrollbar-width:thin]">
              <p className="break-all">deviceId: {device.deviceId}</p>
              <p>platform: web（浏览器客户端）</p>
              <p className="break-all">连接: {connected ? `${hostInfo?.hostName} :${restPort}` : '未连接'}</p>
              {/* 展示用示例 URL 不注入 opsToken（restUrl 会自动附令牌，明文展示有泄露观感且长串溢出）；仅提示存在令牌注入 */}
              <p className="break-all">
                协议: /api/…?XTransformPort={restPort}
                {consoleToken ? <span className="text-amber-600 dark:text-amber-400">（请求自动附加 opsToken=…）</span> : ''}（经网关 XTransformPort）
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">发现机制说明</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="list-inside list-disc space-y-1.5 text-xs leading-relaxed text-muted-foreground">
            <li>
              <span className="font-medium text-foreground">生产环境</span>：Host 通过 Bonjour / Avahi 注册 <code className="rounded bg-muted px-1 font-mono text-[10px]">_ops._tcp</code> 与{' '}
              <code className="rounded bg-muted px-1 font-mono text-[10px]">_ipp._tcp</code> 服务；Android 用 NsdManager、iOS 用 NetServiceBrowser 发现。
            </li>
            <li>
              <span className="font-medium text-foreground">Host 内置 UDP Beacon</span>：每 5 秒向局域网广播 JSON 公告（本沙箱演示环境通过网关 HTTP 发现获取同一信息）。
            </li>
            <li>
              <span className="font-medium text-foreground">Web 控制台</span>：经网关 <code className="rounded bg-muted px-1 font-mono text-[10px]">?XTransformPort={'{port}'}</code> 访问任意
              Host（本页演示单 Host，多 Host 时切换端口即可）。
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}
