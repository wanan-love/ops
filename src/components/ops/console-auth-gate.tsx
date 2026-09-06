'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Eye, EyeOff, KeyRound, Loader2, Lock, ShieldCheck, Unlock } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { useOpsStore } from './store'
import { getConsoleToken } from '@/lib/ops/device'

/**
 * 控制台鉴权解锁界面（P2 安全轮）：
 * Host 启用管理面令牌后，本端未持有效令牌 → 全屏锁定卡片。
 * 输入令牌 → POST /api/console/auth 校验 → 存 localStorage → 自动刷新恢复界面。
 */
export function ConsoleAuthGate() {
  const hostInfo = useOpsStore((s) => s.hostInfo)
  const consoleLogin = useOpsStore((s) => s.consoleLogin)
  // 若本端已有历史令牌（例如重生成后页面刷新）→ 初始化预填（lazy state 避免渲染级联）
  const [token, setToken] = useState(() => (typeof window === 'undefined' ? '' : (getConsoleToken() ?? '')))
  const [reveal, setReveal] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attempts, setAttempts] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const submit = useCallback(async () => {
    const trimmed = token.trim()
    if (!trimmed || verifying) return
    setVerifying(true)
    setError(null)
    const ok = await consoleLogin(trimmed)
    setVerifying(false)
    if (ok) {
      toast.success('控制台已解锁', { description: '访问令牌已保存，管理功能恢复可用' })
    } else {
      setAttempts((n) => n + 1)
      setError(attempts >= 1 ? '令牌仍无效——请核对后重试（完整值见 Host 数据目录 console-token.txt）' : '访问令牌无效')
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [token, verifying, consoleLogin, attempts])

  return (
    <div className="flex min-h-[60vh] flex-1 items-center justify-center py-8" role="alertdialog" aria-labelledby="console-gate-title" aria-describedby="console-gate-desc">
      <motion.div
        initial={{ opacity: 0, y: 10, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.28, ease: 'easeOut' }}
        className="w-full max-w-md"
      >
        <Card className="relative overflow-hidden border-amber-500/30 shadow-lg shadow-amber-500/5">
          {/* 顶部警示渐变条 */}
          <div aria-hidden className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-amber-500/0 via-amber-500 to-amber-500/0" />
          <CardHeader className="pb-2 text-center">
            <motion.div
              initial={{ scale: 0.6, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ delay: 0.08, type: 'spring', stiffness: 260, damping: 18 }}
              className="mx-auto mb-2 flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-500/15 to-amber-600/5 ring-1 ring-amber-500/30"
            >
              <Lock className="size-6 text-amber-600 dark:text-amber-400" aria-hidden />
            </motion.div>
            <CardTitle id="console-gate-title" className="text-lg tracking-tight">
              控制台已锁定
            </CardTitle>
            <p id="console-gate-desc" className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {hostInfo?.hostName ? `${hostInfo.hostName} · ` : ''}该 Host 已启用管理面访问令牌。
              <br />
              REST 管理接口与实时通道需要令牌解锁；设备打印/配对不受影响。
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault()
                void submit()
              }}
            >
              <div className="space-y-1.5">
                <label htmlFor="console-token-input" className="flex items-center justify-between text-xs font-medium text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <KeyRound className="size-3.5" aria-hidden />
                    访问令牌（ops_…）
                  </span>
                  <button
                    type="button"
                    onClick={() => setReveal((v) => !v)}
                    className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-muted-foreground/70 transition-colors duration-200 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    aria-label={reveal ? '隐藏令牌' : '显示令牌'}
                  >
                    {reveal ? <EyeOff className="size-3" aria-hidden /> : <Eye className="size-3" aria-hidden />}
                    {reveal ? '隐藏' : '显示'}
                  </button>
                </label>
                <div className="relative">
                  <Input
                    id="console-token-input"
                    ref={inputRef}
                    type={reveal ? 'text' : 'password'}
                    value={token}
                    onChange={(e) => {
                      setToken(e.target.value)
                      if (error) setError(null)
                    }}
                    placeholder="ops_••••••••••••••••"
                    autoComplete="off"
                    spellCheck={false}
                    className="h-11 pr-11 font-mono text-sm tracking-wide"
                    aria-invalid={!!error}
                    aria-describedby={error ? 'console-token-error' : undefined}
                  />
                  <Unlock className="pointer-events-none absolute right-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/40" aria-hidden />
                </div>
                {error && (
                  <motion.p
                    id="console-token-error"
                    initial={{ opacity: 0, x: -4 }}
                    animate={{ opacity: 1, x: 0 }}
                    className="text-xs font-medium text-red-600 dark:text-red-400"
                    role="alert"
                  >
                    {error}
                  </motion.p>
                )}
              </div>
              <Button type="submit" className="h-11 w-full font-medium" disabled={verifying || token.trim() === ''}>
                {verifying ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                    正在校验…
                  </>
                ) : (
                  <>
                    <ShieldCheck className="size-4" aria-hidden />
                    解锁控制台
                  </>
                )}
              </Button>
            </form>

            <div className="flex items-start gap-2.5 rounded-lg border border-dashed bg-muted/30 p-3">
              <Badge variant="outline" className="mt-0.5 shrink-0 gap-1 border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-700 dark:text-amber-400">
                <Lock className="size-2.5" aria-hidden />
                防丢失
              </Badge>
              <p className="text-[11px] leading-relaxed text-muted-foreground/80">
                令牌由 Host 管理员在「设备配对 → 控制台访问控制」启用时生成；
                遗忘时可读取 Host 数据目录下的 <code className="rounded bg-muted px-1 font-mono text-[10px]">console-token.txt</code> 恢复。
              </p>
            </div>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  )
}
