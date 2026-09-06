import type { HostContext } from '../host'
import type { PrintJob, ScenarioResult, TestStep } from '../core/types'
import { makeApi, ScenarioFailure, ScenarioSkipped, type ScenarioApi } from './selftest'
import { ippScenarios } from './scenarios-ipp'
import { scanScenarios } from './scenarios-scan'
import { pjlScenarios } from './scenarios-pjl'

/**
 * 10 个内置自动化场景（对应“Mock Printer 自动化测试”需求）：
 *  1. normal-print      正常打印（0→25→50→75→100→Completed + 工件落盘）
 *  2. offline-waiting   打印机离线：Job→Queued→等待恢复→Online→继续打印
 *  3. offline-resume    打印中离线：暂停→恢复→续打（进度连续）
 *  4. paper-out         缺纸：Printing→Paper Out→补纸→Resume→Completed
 *  5. paper-jam         卡纸：Printing→Paper Jam→清卡→Resume→Completed
 *  6. print-failure     打印失败：Printing→Printer Error→Failed
 *  7. cancel-job        取消任务：Queued/Printing→Cancel→Cancelled
 *  8. multi-queue       多任务排队：FIFO、同时最多 1 个在打
 *  9. concurrent-jobs   并发任务：两台打印机并行处理
 * 10. host-restart      Host 重启后的任务状态恢复（从磁盘恢复并续打）
 *
 * 阶段 2 追加（scenarios-ipp.ts，虚拟打印机场景不改动）：
 * 11. ipp-full-flow / 12. ipp-capability-unknown / 13. ipp-cancel / 14. mdns-local-discovery / 15. ipps-full-flow
 *
 * P3 追加（scenarios-scan.ts）：
 * 16. escl-full-flow —— eSCL 扫描全链路（vscan 虚拟扫描仪）
 *
 * P3.5 追加（scenarios-scan.ts）：
 * 17. scan-pdf-export —— 扫描 PDF 按需导出（多页 PNG → A4 合成，幂等缓存）
 *
 * P4 追加（scenarios-pjl.ts，首个 Vendor Adapter 试点）：
 * 20. pjl-vendor-probe —— PJL over RAW 9100 双向探测（Virtual PJL :3067 → 状态/耗材回读 → VENDOR_API 融合）
 */
export type ScenarioId =
  | 'normal-print'
  | 'offline-waiting'
  | 'offline-resume'
  | 'paper-out'
  | 'paper-jam'
  | 'print-failure'
  | 'cancel-job'
  | 'multi-queue'
  | 'concurrent-jobs'
  | 'host-restart'
  | 'ipp-full-flow'
  | 'ipp-capability-unknown'
  | 'ipp-cancel'
  | 'mdns-local-discovery'
  | 'ipps-full-flow'
  | 'escl-full-flow'
  | 'scan-pdf-export'
  | 'escl-duplex'
  | 'console-auth'
  | 'pjl-vendor-probe'

interface Scenario {
  id: ScenarioId
  name: string
  description: string
  run(api: ScenarioApi): Promise<void>
}

const scenarios: Scenario[] = [
  {
    id: 'normal-print',
    name: '正常打印',
    description: 'PDF → Virtual Printer → 25% → 50% → 75% → 100% → Completed，工件落盘',
    async run(api) {
      const printer = api.createPrinter('normal-print')
      api.step('创建测试打印机', `${printer.name}（60 ppm）`)
      const job = await api.submit(printer, 2)
      api.step('提交任务', `${job.fileName}，${job.sheetsTotal} 张`)
      const done = await api.waitFor(job.id, (j) => j.state === 'completed')
      api.expect(done.progress === 100, `进度应为 100%（实际 ${done.progress}）`)
      const milestones = done.timeline.filter((e) => e.type === 'progress').map((e) => e.progress ?? 0)
      api.expect([25, 50, 75, 100].every((m) => milestones.some((v) => v >= m)), `时间线应包含 25/50/75/100 里程碑（实际 ${milestones.join(',')}）`)
      api.expect(await api.artifactExists(done, 'document.pdf'), '原始 PDF 已保存（jobs/{id}/document.pdf）')
      api.expect(await api.artifactExists(done, 'job.json'), 'PrintJob + PrintOptions 已保存（job.json）')
      api.expect(await api.artifactExists(done, 'result.json'), '模拟打印结果已保存（result.json）')
      api.step('完成', `用时 ${durationMs(job)}ms，${done.printedSheets} 张，墨量消耗 ${done.inkUsed.black.toFixed(2)}%K`)
    },
  },
  {
    id: 'offline-waiting',
    name: '打印机离线（任务等待恢复）',
    description: 'Queued → Printer Offline → 等待恢复 → Online → 继续打印 → Completed',
    async run(api) {
      const printer = api.createPrinter('offline-waiting')
      api.condition(printer, 'offline')
      api.step('设置打印机离线', 'Set Offline')
      const job = await api.submit(printer, 2)
      await api.sleep(600)
      api.expect(api.getJob(job.id).state === 'pending', '打印机离线时任务应保持 Queued（pending）')
      api.expect(api.getJob(job.id).timeline.some((e) => e.reason === 'printer-offline-waiting'), '时间线应记录“等待恢复”')
      api.condition(printer, 'online')
      api.step('恢复在线', 'Set Online → 自动继续')
      const done = await api.waitFor(job.id, (j) => j.state === 'completed')
      api.expect(done.progress === 100, '恢复后任务应完成')
    },
  },
  {
    id: 'offline-resume',
    name: '打印中离线恢复续打',
    description: 'Printing → Printer Offline（暂停）→ Online → 从原进度继续 → Completed',
    async run(api) {
      const printer = api.createPrinter('offline-resume')
      const job = await api.submit(printer, 2)
      await api.waitFor(job.id, (j) => j.progress >= 25)
      api.step('打印进行中', `进度 ${api.getJob(job.id).progress.toFixed(0)}%`)
      api.condition(printer, 'offline')
      const paused = await api.waitFor(job.id, (j) => j.state === 'paused')
      const progressAtPause = paused.progress
      api.step('打印机离线，任务暂停', `进度停在 ${progressAtPause.toFixed(1)}%`)
      api.condition(printer, 'online')
      const done = await api.waitFor(job.id, (j) => j.state === 'completed')
      api.expect(done.progress === 100, '恢复后应完成（进度连续不清零）')
      api.expect(done.timeline.some((e) => e.reason?.includes('online') || e.message?.includes('恢复')), '时间线应记录恢复打印')
    },
  },
  {
    id: 'paper-out',
    name: '缺纸 → 补纸 → Resume',
    description: 'Printing → Paper Out（暂停）→ 补纸 → Resume → Completed',
    async run(api) {
      const printer = api.createPrinter('paper-out')
      const job = await api.submit(printer, 2)
      await api.waitFor(job.id, (j) => j.progress >= 25)
      api.condition(printer, 'paper-out')
      await api.waitFor(job.id, (j) => j.state === 'paused')
      api.expect(api.getPrinter(printer.id).status === 'paper-out', '打印机状态应为 paper-out')
      api.step('缺纸，任务暂停', `进度 ${api.getJob(job.id).progress.toFixed(1)}%`)
      api.fix(printer, 'add-paper')
      api.step('补纸（add-paper）', '任务保持暂停，等待 Resume')
      api.expect(api.getJob(job.id).state === 'paused', '补纸后任务应仍为 paused（等待手动 Resume）')
      api.resume(printer)
      const done = await api.waitFor(job.id, (j) => j.state === 'completed')
      api.expect(done.progress === 100, 'Resume 后任务应完成')
    },
  },
  {
    id: 'paper-jam',
    name: '卡纸 → 清卡 → Resume',
    description: 'Printing → Paper Jam（暂停）→ Clear Jam → Resume → Completed',
    async run(api) {
      const printer = api.createPrinter('paper-jam')
      const job = await api.submit(printer, 2)
      await api.waitFor(job.id, (j) => j.progress >= 25)
      api.condition(printer, 'paper-jam')
      await api.waitFor(job.id, (j) => j.state === 'paused')
      api.step('卡纸，任务暂停', `进度 ${api.getJob(job.id).progress.toFixed(1)}%`)
      api.fix(printer, 'clear-jam')
      api.step('清除卡纸（clear-jam）', '任务保持暂停')
      api.resume(printer)
      const done = await api.waitFor(job.id, (j) => j.state === 'completed')
      api.expect(done.progress === 100, '清卡 + Resume 后任务应完成')
    },
  },
  {
    id: 'print-failure',
    name: '打印失败',
    description: 'Printing → Printer Error → Failed（Fail Current Job）',
    async run(api) {
      const printer = api.createPrinter('print-failure')
      const job = await api.submit(printer, 2)
      await api.waitFor(job.id, (j) => j.progress >= 25)
      api.failActive(printer, '模拟硒鼓故障（Simulated drum failure）')
      const failed = await api.waitFor(job.id, (j) => j.state === 'failed')
      api.expect(failed.error !== null && failed.error.includes('硒鼓'), '失败原因应写入 job.error')
      api.expect(api.getPrinter(printer.id).status === 'error', '打印机应进入 error 状态')
      api.step('任务失败', failed.error ?? '')
      api.condition(printer, 'online')
      api.expect(api.getPrinter(printer.id).status === 'online', 'Set Online 后打印机恢复')
    },
  },
  {
    id: 'cancel-job',
    name: '取消任务',
    description: 'Printing → Cancel → Cancelled，且队列中下一个任务自动开始',
    async run(api) {
      const printer = api.createPrinter('cancel-job')
      const job1 = await api.submit(printer, 2)
      const job2 = await api.submit(printer, 2)
      await api.waitFor(job1.id, (j) => j.progress >= 25)
      api.cancel(job1)
      const cancelled = await api.waitFor(job1.id, (j) => j.state === 'cancelled')
      api.expect(cancelled.endedAt !== null, '取消时间应写入 endedAt')
      api.step('取消当前任务', 'Cancelled')
      const done2 = await api.waitFor(job2.id, (j) => j.state === 'completed')
      api.expect(done2.progress === 100, '队列中下一个任务应自动开始并完成')
    },
  },
  {
    id: 'multi-queue',
    name: '多任务排队',
    description: '同一打印机 3 个任务：FIFO 顺序完成，任意时刻最多 1 个在打印',
    async run(api) {
      const printer = api.createPrinter('multi-queue')
      const jobs = [await api.submit(printer, 2), await api.submit(printer, 2), await api.submit(printer, 2)]
      api.step('连续提交 3 个任务', jobs.map((j) => j.id).join(' → '))
      // 采样验证同一时刻最多一个 processing
      let maxParallel = 0
      for (let i = 0; i < 24; i++) {
        await api.sleep(200)
        const processing = jobs.filter((j) => api.getJob(j.id).state === 'processing').length
        maxParallel = Math.max(maxParallel, processing)
      }
      api.expect(maxParallel <= 1, `同一打印机同时最多 1 个任务在打（实测峰值 ${maxParallel}）`)
      for (const job of jobs) {
        await api.waitFor(job.id, (j) => j.state === 'completed')
      }
      const order = jobs.map((j) => api.getJob(j.id).endedAt ?? '')
      api.expect(order[0] <= order[1] && order[1] <= order[2], `完成顺序应符合 FIFO（${order.join(' ≤ ')}）`)
      api.step('全部完成', `并行峰值 ${maxParallel}，FIFO 顺序正确`)
    },
  },
  {
    id: 'concurrent-jobs',
    name: '并发任务',
    description: '两台打印机同时各打印一个任务：并行推进、双双完成',
    async run(api) {
      const printerA = api.createPrinter('concurrent-a')
      const printerB = api.createPrinter('concurrent-b')
      const jobA = await api.submit(printerA, 2)
      const jobB = await api.submit(printerB, 2)
      api.step('两台打印机同时提交', `${jobA.id} / ${jobB.id}`)
      let sawParallel = false
      for (let i = 0; i < 40; i++) {
        await api.sleep(150)
        const a = api.getJob(jobA.id)
        const b = api.getJob(jobB.id)
        if (a.state === 'processing' && b.state === 'processing' && a.progress > 3 && b.progress > 3) {
          sawParallel = true
          break
        }
      }
      api.expect(sawParallel, '两台打印机应同时处于 printing 状态')
      await api.waitFor(jobA.id, (j) => j.state === 'completed')
      await api.waitFor(jobB.id, (j) => j.state === 'completed')
      api.step('双双完成', `${printerA.name} 与 ${printerB.name} 并行完成`)
    },
  },
  {
    id: 'host-restart',
    name: 'Host 重启后的任务状态',
    description: '打印中模拟 Host 重启 → 从磁盘恢复状态与进度 → 自动续打 → Completed',
    async run(api) {
      const printer = api.createPrinter('host-restart')
      const job = await api.submit(printer, 2)
      await api.waitFor(job.id, (j) => j.progress >= 25)
      const progressBefore = api.getJob(job.id).progress
      api.step('打印中，准备重启 Host', `进度 ${progressBefore.toFixed(1)}%`)
      api.restartHost()
      await api.sleep(700) // 等待磁盘状态重建
      const after = api.getJob(job.id)
      api.expect(['processing', 'pending', 'paused'].includes(after.state), `重启后任务应仍在进行（实际 ${after.state}）`)
      api.expect(after.progress >= progressBefore - 1, `进度应从磁盘恢复（重启前 ${progressBefore.toFixed(1)}%，重启后 ${after.progress.toFixed(1)}%）`)
      api.expect(after.timeline.some((e) => e.reason === 'host-restart'), '时间线应记录 host-restart')
      const done = await api.waitFor(job.id, (j) => j.state === 'completed')
      api.expect(done.progress === 100, '重启恢复后任务应完成')
    },
  },
  {
    id: 'console-auth',
    name: '控制台鉴权（管理面令牌）',
    description: '启用 → REST 401（带 code 标记）→ 令牌三通道放行（header/query/Bearer）→ 公白白名单 → 重生成旧令牌失效 → 关闭恢复开放',
    async run(api) {
      try {
        // 0. 预备：确保从开放态开始
        await api.setConsoleAuth(false)
        const openBefore = await api.httpProbe('GET', '/api/printers')
        api.expect(openBefore.status === 200, `开放态 GET /api/printers 应 200（实际 ${openBefore.status}）`)

        // 1. 通过真实 HTTP 启用（公网白名单：收紧操作永远允许）
        const enableRes = await api.httpProbe('POST', '/api/console/enable', { body: {} })
        api.expect(enableRes.status === 200, `POST /api/console/enable 应 200（实际 ${enableRes.status}）`)
        const token = enableRes.json?.token
        api.expect(typeof token === 'string' && (token as string).startsWith('ops_') && (token as string).length >= 40, `应返回 ops_ 前缀令牌（实际 ${String(token).slice(0, 12)}…）`)
        api.step('启用控制台鉴权', `令牌 ${String(token).slice(0, 12)}…（完整值已落盘 data/console-token.txt）`)

        // 2. 无令牌 → 401 + console_auth_required 标记（前端据此弹解锁界面）
        const denied = await api.httpProbe('GET', '/api/printers')
        api.expect(denied.status === 401, `无令牌 GET /api/printers 应 401（实际 ${denied.status}）`)
        api.expect(denied.json?.code === 'console_auth_required', '401 响应应携带 console_auth_required code 标记')

        // 3. 伪令牌 → 401
        const wrong = await api.httpProbe('GET', '/api/printers', { token: 'WRONG' })
        api.expect(wrong.status === 401, `伪令牌应 401（实际 ${wrong.status}）`)

        // 4. 有效令牌（header）→ 200
        const okHeader = await api.httpProbe('GET', '/api/printers', { token: token as string })
        api.expect(okHeader.status === 200, `有效令牌 header 应 200（实际 ${okHeader.status}）`)

        // 5. query 通道（opsToken=）→ 200（<img>/下载链接兼容）
        const okQuery = await api.httpProbe('GET', `/api/printers?opsToken=${encodeURIComponent(token as string)}`)
        api.expect(okQuery.status === 200, `query opsToken 通道应 200（实际 ${okQuery.status}）`)

        // 6. 公白白名单：system/info 无令牌可读（发现/探活），且带 consoleAuthEnabled 标志
        const info = await api.httpProbe('GET', '/api/system/info')
        api.expect(info.status === 200, `白名单 GET /api/system/info 应 200（实际 ${info.status}）`)
        api.expect(info.json?.consoleAuthEnabled === true, 'HostInfo 应携带 consoleAuthEnabled=true')

        // 7. 登录端点：伪令牌 401，有效令牌 200
        const badLogin = await api.httpProbe('POST', '/api/console/auth', { body: { token: 'WRONG' } })
        api.expect(badLogin.status === 401, `登录校验伪令牌应 401（实际 ${badLogin.status}）`)
        const login = await api.httpProbe('POST', '/api/console/auth', { body: { token } })
        api.expect(login.status === 200, `登录校验有效令牌应 200（实际 ${login.status}）`)

        // 8. 设备配对轴不受控制台鉴权影响：POST /api/pairing/requests 无令牌可达（400 语义错误 ≠ 401 鉴权错误）
        const pairing = await api.httpProbe('POST', '/api/pairing/requests', { body: {} })
        api.expect(pairing.status === 400, `设备配对发起（空 body）应 400 语义错误而非 401（实际 ${pairing.status}）`)

        // 9. 重生成：旧令牌立即失效、新令牌可用
        const regen = await api.httpProbe('POST', '/api/console/token/regenerate', { token: token as string })
        api.expect(regen.status === 200, `持旧令牌重生成应 200（实际 ${regen.status}）`)
        const newToken = regen.json?.token
        api.expect(typeof newToken === 'string' && newToken !== token, '应生成与旧值不同的新令牌')
        const oldDead = await api.httpProbe('GET', '/api/printers', { token: token as string })
        api.expect(oldDead.status === 401, `旧令牌重生成后应 401（实际 ${oldDead.status}）`)
        const newOk = await api.httpProbe('GET', '/api/printers', { token: newToken as string })
        api.expect(newOk.status === 200, `新令牌应 200（实际 ${newOk.status}）`)
        api.step('重生成令牌', '旧令牌已失效，新令牌立即可用')

        // 10. 关闭（需有效令牌）→ 恢复开放
        const disableBad = await api.httpProbe('POST', '/api/console/disable', { token: 'WRONG' })
        api.expect(disableBad.status === 401, `伪令牌关闭应 401（实际 ${disableBad.status}）`)
        const disable = await api.httpProbe('POST', '/api/console/disable', { token: newToken as string })
        api.expect(disable.status === 200, `持有效令牌关闭应 200（实际 ${disable.status}）`)
        const reopened = await api.httpProbe('GET', '/api/printers')
        api.expect(reopened.status === 200, `关闭后无令牌 GET /api/printers 应恢复 200（实际 ${reopened.status}）`)
        api.step('关闭并恢复', `settings.consoleAuth = ${JSON.stringify((disable.json?.settings as { consoleAuth?: unknown })?.consoleAuth ?? null)}`)
      } finally {
        // 清理：无论成败都必须回到开放态，避免鉴权门影响后续场景/QA
        await api.setConsoleAuth(false)
      }
    },
  },
]

function durationMs(job: PrintJob): number {
  if (!job.startedAt || !job.endedAt) return 0
  return new Date(job.endedAt).getTime() - new Date(job.startedAt).getTime()
}

export function scenarioMeta(): Array<{ id: string; name: string; description: string }> {
  return [...scenarios, ...ippScenarios, ...scanScenarios, ...pjlScenarios].map(({ id, name, description }) => ({ id, name, description }))
}

export async function runScenarios(
  ctx: HostContext,
  ids: ScenarioId[],
  onProgress: (results: ScenarioResult[]) => void,
  manifest?: import('./selftest').RunManifest,
): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = []
  const all: Scenario[] = [
    ...scenarios,
    ...ippScenarios.map((sc) => ({ ...sc, id: sc.id as ScenarioId, run: (api: ScenarioApi) => sc.run(api) })),
    ...scanScenarios.map((sc) => ({ ...sc, id: sc.id as ScenarioId, run: (api: ScenarioApi) => sc.run(api) })),
    ...pjlScenarios.map((sc) => ({ ...sc, id: sc.id as ScenarioId, run: (api: ScenarioApi) => sc.run(api) })),
  ]
  for (const scenario of all) {
    if (!ids.includes(scenario.id)) continue
    const startedAt = Date.now()
    const steps: TestStep[] = []
    const api = makeApi(ctx, steps, manifest)
    let result: ScenarioResult
    try {
      await scenario.run(api)
      result = {
        id: scenario.id,
        name: scenario.name,
        description: scenario.description,
        status: 'pass',
        durationMs: Date.now() - startedAt,
        steps,
      }
    } catch (err) {
      if (err instanceof ScenarioSkipped) {
        // 环境原因跳过（组播不可用 / 后端禁用等）——不算失败
        results.push({
          id: scenario.id,
          name: scenario.name,
          description: scenario.description,
          status: 'skipped',
          durationMs: Date.now() - startedAt,
          steps,
          error: `SKIPPED：${err.message}`,
        })
        onProgress([...results])
        continue
      }
      const message = err instanceof ScenarioFailure ? err.message : err instanceof Error ? `${err.message}` : String(err)
      const failedIdx = steps.length > 0 ? steps.length - 1 : 0
      const markedSteps = [...steps]
      if (markedSteps.length > 0) markedSteps[markedSteps.length - 1] = { ...markedSteps[failedIdx], ok: false }
      result = {
        id: scenario.id,
        name: scenario.name,
        description: scenario.description,
        status: err instanceof ScenarioFailure ? 'fail' : 'error',
        durationMs: Date.now() - startedAt,
        steps: markedSteps,
        error: message,
      }
      ctx.log.record({ type: 'test', topic: `scenario:${scenario.id}`, message: `场景失败：${scenario.name} — ${message}` })
    }
    results.push(result)
    onProgress([...results])
  }
  return results
}
