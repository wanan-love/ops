import type { PrintJob, Printer } from '../core/types'
import { ScenarioSkipped, type ScenarioApi } from './selftest'

/**
 * 真实 IPP 后端场景（阶段 2，Virtual IPP Server :3061 提供可验证链路）：
 *  11. ipp-full-flow          导入 vipp-full → 能力四元组（IPP 来源）→ 真实 IPP Print-Job → completed → 工件落盘
 *  12. ipp-capability-unknown 导入 vipp-basic → 双面/耗材 UNKNOWN（属性缺失 ≠ 不支持）→ 打印仍成功
 *  13. ipp-cancel             提交多页任务 → 打印中取消 → IPP Cancel-Job 生效 → cancelled
 *  14. mdns-local-discovery   mDNS 扫描发现本机 Virtual IPP 通告（组播不可用 → skipped 而非 fail）
 *  15. ipps-full-flow         ipps:// TLS 全链路（自签容忍 TOFU）→ 能力探测 → Print-Job over TLS → completed
 */
export type IppScenarioId = 'ipp-full-flow' | 'ipp-capability-unknown' | 'ipp-cancel' | 'mdns-local-discovery' | 'ipps-full-flow'

export interface IppScenario {
  id: IppScenarioId
  name: string
  description: string
  run(api: ScenarioApi): Promise<void>
}

export const ippScenarios: IppScenario[] = [
  {
    id: 'ipp-full-flow',
    name: 'IPP 全链路（vipp-full）',
    description: '导入 vipp-full → 能力四元组（IPP 来源）→ BackendJobRunner 真实 IPP Print-Job → completed → result 落盘',
    async run(api) {
      if (!api.vippAvailable()) throw new ScenarioSkipped('Virtual IPP Server 未启用（OPS_VIPP_ENABLED=0）')
      const printer = await api.importFromBackend('ipp', 'vipp-full')
      api.step('导入 vipp-full', `${printer.name}（${printer.backendUri ?? ''}，backend=${printer.backend}）`)
      const report = printer.capabilityReport
      api.expect(printer.backend === 'ipp', `导入后 backend 应为 ipp（实际 ${printer.backend}）`)
      api.expect(report !== undefined, '导入后应立即生成 capabilityReport')
      if (!report) return
      api.expect(report.color.state === 'supported' && report.color.value === true, `color 应为 supported/true（实际 ${report.color.state}/${String(report.color.value)}）`)
      api.expect(report.color.source === 'IPP', `color 来源应为 IPP（实际 ${report.color.source}）`)
      api.expect(report.color.timestamp !== undefined && !Number.isNaN(Date.parse(report.color.timestamp)), 'color 四元组 timestamp 合法')
      api.expect(report.duplex.state === 'supported' && report.duplex.value === 'both', `duplex 应为 supported/both（实际 ${report.duplex.state}/${String(report.duplex.value)}）`)
      api.expect(report.maxCopies.state === 'supported' && report.maxCopies.value === 99, `maxCopies 应为 99（实际 ${String(report.maxCopies.value)}）`)
      api.expect(report.paperSizes.state === 'supported' && (report.paperSizes.value ?? []).includes('A4'), 'paperSizes 应含 A4')
      api.expect(report.consumables.state === 'supported', `vipp-full 耗材应为 supported（实际 ${report.consumables.state}）`)
      const supplies = report.consumables.value ?? []
      api.expect(supplies.length === 4, `应有 4 个耗材条目（实际 ${supplies.length}）`)
      api.expect(supplies.every((s) => typeof s.levelPct === 'number' && s.levelPct >= 0 && s.levelPct <= 100), '每个耗材应有数值墨量（82/64/91/77）')
      api.expect(report.probes.some((p) => p.source === 'IPP' && p.ok), 'probes 应含成功的 IPP 探测记录')

      const job = await api.submit(printer, 2)
      api.step('提交任务', `${job.id}（${job.sheetsTotal} 张，走 BackendJobRunner → 真实 IPP Print-Job）`)
      const done = await api.waitFor(job.id, (j) => j.state === 'completed', 30000)
      api.expect(done.progress === 100, '任务应完成（progress=100）')
      api.expect(done.backendJobId !== undefined && done.backendJobId !== '', 'job 应记录 backendJobId（IPP job-id）')
      api.expect(done.timeline.some((e) => e.reason === 'backend-submit'), '时间线应包含 backend-submit 后端提交记录')
      const milestones = done.timeline.filter((e) => e.type === 'progress').map((e) => e.progress ?? 0)
      api.expect([25, 50, 75, 100].every((m) => milestones.some((v) => v >= m)), `时间线应含 25/50/75/100 里程碑（实际 ${milestones.join(',')}）`)
      api.expect(await api.artifactExists(done, 'result.json'), 'result.json 已落盘')
      api.step('完成', `backend job ${done.backendJobId}，${done.printedSheets} 张，用时 ${durationMs(done)}ms`)
    },
  },
  {
    id: 'ipp-capability-unknown',
    name: 'IPP 能力缺失 → UNKNOWN（打印不受影响）',
    description: '导入 vipp-basic：无 sides-supported → duplex UNKNOWN；无 marker-* → 耗材 UNKNOWN；提交打印仍 completed（读取不到 ≠ 不支持）',
    async run(api) {
      if (!api.vippAvailable()) throw new ScenarioSkipped('Virtual IPP Server 未启用（OPS_VIPP_ENABLED=0）')
      const printer = await api.importFromBackend('ipp', 'vipp-basic')
      api.step('导入 vipp-basic（能力吝啬档案）', `${printer.name}（无 sides-supported / 无 marker-*）`)
      const report = printer.capabilityReport
      api.expect(report !== undefined, '应生成 capabilityReport')
      if (!report) return
      api.expect(report.duplex.state === 'unknown', `无 sides-supported → duplex.state 应为 unknown（实际 ${report.duplex.state}）`)
      api.expect(report.duplex.value === null, 'duplex.value 应为 null')
      api.expect(report.consumables.state === 'unknown', `无 marker-levels → consumables.state 应为 unknown（实际 ${report.consumables.state}）`)
      api.expect(report.consumables.value === null, '耗材 value 应为 null（UI 将隐藏耗材模块）')
      api.expect(report.color.state === 'supported' && report.color.value === true, 'color-supported 存在 → supported/true')
      // 能力钳制：duplex UNKNOWN → 'both'（允许提交，交给驱动判断）
      api.expect(printer.capabilities.duplex === 'both', `unknown 不钳制成最小：capabilities.duplex 应为 both（实际 ${printer.capabilities.duplex}）`)

      // 协议能力缺失不影响打印可用性
      const job = await api.submit(printer, 2)
      api.step('提交打印（能力 UNKNOWN 的打印机）', `${job.id}`)
      const done = await api.waitFor(job.id, (j) => j.state === 'completed', 30000)
      api.expect(done.progress === 100, '任务应完成 —— 协议能力缺失不影响打印')
      api.expect(done.error === null, '不应有错误')
    },
  },
  {
    id: 'ipp-cancel',
    name: 'IPP 任务取消（Cancel-Job）',
    description: '提交多页任务 → 打印中 Cancel → IPP Cancel-Job 生效（vipp 内部状态 canceled）→ job cancelled',
    async run(api) {
      if (!api.vippAvailable()) throw new ScenarioSkipped('Virtual IPP Server 未启用（OPS_VIPP_ENABLED=0）')
      const printer = await api.importFromBackend('ipp', 'vipp-full')
      const job = await api.submit(printer, 20)
      api.step('提交 20 页任务', `${job.id}（${job.sheetsTotal} 张）`)
      // 等待已提交到后端并开始打印
      const started = await api.waitFor(job.id, (j) => j.state === 'processing' && !!j.backendJobId && j.progress >= 1, 30000)
      api.step('打印进行中', `backend job ${started.backendJobId}，进度 ${started.progress.toFixed(1)}%`)
      api.cancel(started)
      const cancelled = await api.waitFor(job.id, (j) => j.state === 'cancelled', 15000)
      api.expect(cancelled.state === 'cancelled', '任务状态应为 cancelled')
      api.expect(cancelled.timeline.some((e) => e.to === 'cancelled' && (e.message ?? '').includes('Cancel-Job')), '时间线应记录 IPP Cancel-Job 生效')
      // 服务端验证：vipp 内部任务状态应为 canceled
      const serverState = api.vippJobState('vipp-full', cancelled.backendJobId ?? '')
      api.expect(serverState === 'canceled', `vipp 服务端任务应为 canceled（实际 ${String(serverState)}）`)
      api.step('Cancel-Job 验证完成', `backend job ${cancelled.backendJobId} 服务端状态=${String(serverState)}`)
      // 打印机恢复可用
      await api.sleep(600)
      const printerAfter = api.getPrinter(printer.id)
      api.expect(printerAfter.status !== 'busy', `取消后打印机应释放（实际 ${printerAfter.status}）`)
    },
  },
  {
    id: 'mdns-local-discovery',
    name: 'mDNS 本机发现',
    description: 'mDNS 扫描 → 发现至少 1 台 vipp 通告的 IPP 打印机（uri 含 :3061）；组播不可用 → skipped',
    async run(api) {
      if (!api.mdnsAvailable()) {
        throw new ScenarioSkipped('mDNS socket 不可用（组播被环境禁用或权限不足）')
      }
      let printers = await api.mdnsScan()
      if (printers.length === 0) {
        // 第二次尝试（首次查询/通告时序偶发）
        await api.sleep(500)
        printers = await api.mdnsScan()
      }
      if (printers.length === 0) {
        throw new ScenarioSkipped('mDNS 窗口期内未收到响应（组播回环可能被环境禁用）')
      }
      api.step('扫描完成', `发现 ${printers.length} 台：${printers.map((p) => p.name).join('、')}`)
      const vippFound = printers.filter((p) => p.uri.includes(':3061'))
      api.expect(vippFound.length >= 1, `应发现本机 Virtual IPP 通告（uri 含 :3061；实际 ${printers.map((p) => p.uri).join('、')}）`)
      if (vippFound.length > 0) {
        const first = vippFound[0]!
        api.expect(first.uri.startsWith('ipp://'), `URI 应为 ipp:// 协议（实际 ${first.uri}）`)
        api.expect(first.txt['rp'] !== undefined || first.uri.includes('/printers/'), 'TXT rp 或 URI 路径应指向打印机资源')
        api.step('vipp 通告详情', `${first.name} → ${first.uri}`)
      }
    },
  },
  {
    id: 'ipps-full-flow',
    name: 'ipps:// TLS 全链路（vipp-full）',
    description: 'ipps://127.0.0.1:3063 导入 vipp-full → TLS 自签名容忍（TOFU）→ 能力探测（IPP 来源）→ 真实 IPP Print-Job over TLS → completed → 工件落盘',
    async run(api) {
      if (!api.vippAvailable()) throw new ScenarioSkipped('Virtual IPP Server 未启用（OPS_VIPP_ENABLED=0）')
      if (!api.vippTlsAvailable()) throw new ScenarioSkipped('Virtual IPP TLS 未启用（证书生成失败或 OPS_VIPP_TLS=0）')
      const tlsPort = 3063
      const uri = `ipps://127.0.0.1:${tlsPort}/printers/vipp-full`
      const printer = await api.importFromUri('ipp', uri)
      api.step('导入 vipp-full（ipps/TLS）', `${printer.name}（${printer.backendUri ?? ''}）`)
      const report = printer.capabilityReport
      api.expect(printer.backend === 'ipp', `导入后 backend 应为 ipp（实际 ${printer.backend}）`)
      api.expect(printer.backendUri === uri, `backendUri 应为 ipps URI（实际 ${printer.backendUri}）`)
      api.expect(report !== undefined, '导入后应立即生成 capabilityReport（经 TLS Get-Printer-Attributes）')
      if (!report) return
      api.expect(report.probes.some((p) => p.source === 'IPP' && p.ok), 'probes 应含成功的 IPP 探测（TLS 链路）')
      api.expect(report.color.state === 'supported' && report.color.value === true, `TLS 链路 color 应为 supported/true（实际 ${report.color.state}/${String(report.color.value)}）`)
      api.expect(report.consumables.state === 'supported', `TLS 链路耗材应 supported（实际 ${report.consumables.state}）`)
      const supplies = report.consumables.value ?? []
      api.expect(supplies.length === 4, `TLS 链路应有 4 个耗材条目（实际 ${supplies.length}）`)
      const job = await api.submit(printer, 2)
      api.step('提交任务（over TLS）', `${job.id}（${job.sheetsTotal} 张，IPP Print-Job → https://127.0.0.1:${tlsPort}）`)
      const done = await api.waitFor(job.id, (j) => j.state === 'completed', 30000)
      api.expect(done.progress === 100, '任务应完成（progress=100）')
      api.expect(done.backendJobId !== undefined && done.backendJobId !== '', 'job 应记录 backendJobId（IPP job-id）')
      api.expect(await api.artifactExists(done, 'result.json'), 'result.json 已落盘')
      api.step('完成', `backend job ${done.backendJobId}（TLS 链路），${done.printedSheets} 张`)
    },
  },
]

function durationMs(job: PrintJob): number {
  if (!job.startedAt || !job.endedAt) return 0
  return new Date(job.endedAt).getTime() - new Date(job.startedAt).getTime()
}

