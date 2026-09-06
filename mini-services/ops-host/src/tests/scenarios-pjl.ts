import type { CapabilityReport } from '../core/types'
import { ScenarioFailure, ScenarioSkipped, type ScenarioApi, type TestStep } from './selftest'

/** P4 · PJL over RAW 9100（Vendor Adapter 试点）自测场景（scenarios-pjl.ts） */

export interface PjlScenario {
  id: string
  name: string
  description: string
  run: (api: ScenarioApi, steps: TestStep[]) => Promise<void>
}

export const pjlScenarios: PjlScenario[] = [
  {
    id: 'pjl-vendor-probe',
    name: 'PJL over RAW 9100 双向探测（Vendor Adapter 试点）',
    description:
      'Virtual PJL（:3067）直连探测（INFO STATUS/SUPPLY）→ 启用 PJL 设置（PATCH settings 真实路由）→ 导入 vipp-basic（无 IPP 耗材）→ 刷新能力（VENDOR_API 耗材兑底融合）→ paper-out 状态融合 → toner-low 耗材联动（状态不映射）→ RAW 数据字节累计 → 关闭后探测消失 → settings 还原',
    async run(api) {
      if (!api.vpjlAvailable()) throw new ScenarioSkipped('Virtual PJL Printer 未启用（OPS_VPJL_ENABLED=0）')

      // ---------------------------------------------------------------- 1) 设备快照 + 直连探测（客户端单元级）
      const stateRes = await api.httpProbe('GET', '/api/vpjl/state')
      if (stateRes.status !== 200 || !stateRes.json?.state) throw new ScenarioFailure(`GET /api/vpjl/state 应 200（实际 ${stateRes.status}）`)
      api.step('虚拟 PJL 设备快照', `condition=${(stateRes.json.state as { condition: string }).condition}`)

      const direct = await api.pjlDirectProbe(3067)
      api.expect(direct.status.ok, '直连 INFO STATUS 应成功（UEL 包裹查询 → 响应解析）')
      api.expect(direct.status.rawCode === '10001', `ready 状态 CODE 应 10001（实际 ${direct.status.rawCode}）`)
      api.expect(direct.status.status === 'online', `10001 应映射 online（实际 ${direct.status.status}）`)
      api.expect(direct.supply.ok, '直连 INFO SUPPLY 应成功')
      api.expect(direct.supply.levelPct === 62, `默认碳粉应 62%（实际 ${direct.supply.levelPct}）`)
      api.step('直连 PJL 探测', `CODE=${direct.status.rawCode}（${direct.status.display}），碳粉 ${direct.supply.levelPct}%（UEL 双向回读）`)

      // ---------------------------------------------------------------- 2) RAW 数据通道（9100 收数据即打——字节级诚实累计）
      const beforeBytes = (stateRes.json.state as { rawReceivedBytes: number }).rawReceivedBytes
      await api.pjlSendRaw('\x1b%-12345X' + 'OPS-PJL-RAW-PAYLOAD-0123456789'.repeat(8) + '\x1b%-12345X')
      await api.sleep(300) // 等待服务端 data 事件处理完成（事件循环时序兜底）
      const after = await api.httpProbe('GET', '/api/vpjl/state')
      const afterBytes = (after.json?.state as { rawReceivedBytes: number } | undefined)?.rawReceivedBytes ?? -1
      api.expect(afterBytes >= beforeBytes + 200, `RAW 字节应累计（${beforeBytes} → ${afterBytes}）`)
      api.step('RAW 数据通道', `UEL 之间非 PJL 字节累计 ${beforeBytes} → ${afterBytes}（fire-and-forget，对齐真实 9100）`)

      // ---------------------------------------------------------------- 3) 启用 PJL 探测（真实 settings 路由 + 校验）
      const prevSettings = await api.httpProbe('GET', '/api/settings')
      const prevPjl = (prevSettings.json?.settings as { pjlProbeEnabled?: boolean; pjlPort?: number } | undefined) ?? {}
      const enableRes = await api.httpProbe('PATCH', '/api/settings', { body: { pjlProbeEnabled: true, pjlPort: 3067 } })
      if (enableRes.status !== 200) throw new ScenarioFailure(`启用 PJL 探测应 200（实际 ${enableRes.status}：${enableRes.bodyText.slice(0, 120)}）`)
      api.step('启用 PJL 探测（settings）', 'pjlProbeEnabled=true，pjlPort=3067（真实 PATCH 路由 + 1-65535 校验）')
      // 非法端口应 400（校验路径）
      const badPort = await api.httpProbe('PATCH', '/api/settings', { body: { pjlPort: 99999 } })
      api.expect(badPort.status === 400, `pjlPort=99999 应 400（实际 ${badPort.status}）`)

      try {
        // ------------------------------------------------------------ 4) 导入 vipp-basic 打印机（无 IPP 耗材 → PJL 是耗材兑底来源；backendUri → host 127.0.0.1）
        const printer = await api.importFromUri('ipp', 'ipp://127.0.0.1:3061/printers/vipp-basic')
        api.step('导入 vipp-basic', `${printer.name}（backendUri=${printer.backendUri}，PJL 探测目标 127.0.0.1:3067；IPP 无 marker-* 耗材 → VENDOR_API 兑底）`)

        // ------------------------------------------------------------ 5) 刷新能力：VENDOR_API 探测 + 耗材融合
        const refresh1 = await api.httpProbe('POST', `/api/printers/${printer.id}/refresh-capabilities`)
        if (refresh1.status !== 200) throw new ScenarioFailure(`刷新能力应 200（实际 ${refresh1.status}）`)
        const report1 = (refresh1.json?.report ?? printer.capabilityReport) as CapabilityReport | undefined
        api.expect(report1 !== undefined, '刷新后应返回能力报告')
        if (!report1) return
        const pjlProbe = report1.probes.find((p) => p.source === 'VENDOR_API')
        api.expect(pjlProbe !== undefined && pjlProbe.ok === true, 'probes 应含成功的 VENDOR_API（PJL）探测')
        api.expect(
          report1.probes.some((p) => p.source === 'VENDOR_API' && p.detail?.includes('10001') === true),
          `应有带原始 CODE 的 PJL STATUS 探测记录（实际 ${report1.probes.filter((p) => p.source === 'VENDOR_API').map((p) => p.detail).join(' | ')}）`,
        )
        api.expect(report1.consumables.state === 'supported', `PJL 耗材应 supported（实际 ${report1.consumables.state}）`)
        const merged = report1.consumables.value ?? []
        api.expect(merged.some((c) => c.source === 'VENDOR_API' && c.levelPct === 62), `耗材应含 VENDOR_API 来源 62%（实际 ${merged.map((c) => `${c.source}:${c.levelPct}`).join(',')}）`)
        api.step(
          '刷新能力（PJL 融合）',
          `probes=${report1.probes.map((p) => `${p.source}:${p.ok ? 'ok' : 'fail'}`).join(' ')}，耗材来源=${merged[0]?.source ?? '?'} ${merged[0]?.levelPct ?? '?'}%`,
        )

        // ------------------------------------------------------------ 6) paper-out 状态融合（40014 → paper-out）
        await api.httpProbe('POST', '/api/vpjl/condition', { body: { condition: 'paper-out' } })
        const refresh2 = await api.httpProbe('POST', `/api/printers/${printer.id}/refresh-capabilities`)
        const printer2 = (refresh2.json?.printer as { status?: string; statusMessage?: string } | undefined) ?? {}
        api.expect(printer2.status === 'paper-out', `PJL 40014 应融合为 paper-out（实际 ${printer2.status}）`)
        api.expect((printer2.statusMessage ?? '').includes('PAPER OUT'), `状态附言应含 PAPER OUT（实际 ${printer2.statusMessage}）`)
        api.step('状态融合（缺纸）', `PJL CODE 40014 → printer.status=${printer2.status}（SNMP 失败时 PJL 为状态兜底来源）`)

        // ------------------------------------------------------------ 7) 恢复 ready → IPP 状态同步（5s 轮询）回到 online
        await api.httpProbe('POST', '/api/vpjl/condition', { body: { condition: 'ready' } })
        const restored = await api.waitForPrinterStatus(printer.id, (p) => p.status === 'online', 12000)
        api.expect(restored.status === 'online', `IPP 状态同步应恢复 online（实际 ${restored.status}）`)
        api.step('恢复 online', 'vpjl→ready 后 IPP 后端状态同步（5s 轮询）恢复 online——演示多来源状态优先级')

        // ------------------------------------------------------------ 8) toner-low：耗材联动 + 状态不映射（40036 属耗材域）
        await api.httpProbe('POST', '/api/vpjl/condition', { body: { condition: 'toner-low' } })
        const refresh3 = await api.httpProbe('POST', `/api/printers/${printer.id}/refresh-capabilities`)
        const printer3 = (refresh3.json?.printer as { status?: string } | undefined) ?? {}
        const report3 = (refresh3.json?.report) as CapabilityReport | undefined
        api.expect(printer3.status === 'online', `40036 属耗材域不应改状态（实际 ${printer3.status}）`)
        const low = (report3?.consumables.value ?? []).find((c) => c.source === 'VENDOR_API')
        api.expect(low?.levelPct === 8, `toner-low 应联动耗材 8%（实际 ${low?.levelPct}）`)
        api.step('碳粉低（40036）', `耗材 ${low?.levelPct}%（状态保持 online——CODE 40036 不映射状态，不猜测）`)

        // ------------------------------------------------------------ 9) 关闭 PJL 探测 → 探测消失
        await api.httpProbe('POST', '/api/vpjl/condition', { body: { condition: 'ready' } })
        await api.httpProbe('PATCH', '/api/settings', { body: { pjlProbeEnabled: false } })
        const refresh4 = await api.httpProbe('POST', `/api/printers/${printer.id}/refresh-capabilities`)
        const report4 = (refresh4.json?.report) as CapabilityReport | undefined
        api.expect(!report4?.probes.some((p) => p.source === 'VENDOR_API'), '关闭后 probes 不应再含 VENDOR_API（安全默认：显式启用）')
        api.step('关闭后探测消失', `probes=${report4?.probes.map((p) => p.source).join(' ') || '（空）'}——默认关闭需显式启用`)
      } finally {
        // ------------------------------------------------------------ 10) settings 还原（finally 保证：即使中途断言失败）
        await api.httpProbe('PATCH', '/api/settings', {
          body: { pjlProbeEnabled: prevPjl.pjlProbeEnabled === true, pjlPort: prevPjl.pjlPort ?? 9100 },
        })
        await api.httpProbe('POST', '/api/vpjl/condition', { body: { condition: 'ready' } })
        api.step('还原', `settings.pjlProbeEnabled=${prevPjl.pjlProbeEnabled === true}，pjlPort=${prevPjl.pjlPort ?? 9100}，vpjl→ready（打印机清理由 RunManifest 自动完成）`)
      }
    },
  },
]
