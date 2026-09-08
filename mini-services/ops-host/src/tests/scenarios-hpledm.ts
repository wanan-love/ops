import type { CapabilityReport } from '../core/types'
import { ScenarioFailure, ScenarioSkipped, type ScenarioApi, type TestStep } from './selftest'

/** P9 · HP LEDM/CDM（Vendor Adapter 第二个：HPLIP 源码实证通道）自测场景（scenarios-hpledm.ts） */

export interface HpLedmScenario {
  id: string
  name: string
  description: string
  run: (api: ScenarioApi, steps: TestStep[]) => Promise<void>
}

export const hpLedmScenarios: HpLedmScenario[] = [
  {
    id: 'hp-ledm-vendor-probe',
    name: 'HP LEDM/CDM Vendor Adapter 探测（HPLIP 实证通道）',
    description:
      'Virtual HP LEDM/CDM（:3068）直连探测（XML 三文档 + CDM JSON）→ 命名空间剥除验证（bare 风格）→ 启用 HP 探测（PATCH settings 真实路由）→ 导入 vipp-basic → 刷新能力（VENDOR_API 耗材/纸盒/双面融合）→ paper-out 状态融合 → toner-low 耗材联动（状态不映射）→ 404 全失败 → UNKNOWN 兜底 → settings 还原',
    async run(api) {
      if (!api.vledmAvailable()) throw new ScenarioSkipped('Virtual HP LEDM/CDM Printer 未启用（OPS_VLEDM_ENABLED=0）')

      // ---------------------------------------------------------------- 1) 设备快照 + 直连探测（客户端单元级：LEDM XML 三文档 + CDM JSON）
      const stateRes = await api.httpProbe('GET', '/api/vledm/state')
      if (stateRes.status !== 200 || !stateRes.json?.state) throw new ScenarioFailure(`GET /api/vledm/state 应 200（实际 ${stateRes.status}）`)
      api.step('虚拟 HP 设备快照', `condition=${(stateRes.json.state as { condition: string }).condition}，style=${(stateRes.json.state as { style: string }).style}`)

      const direct = await api.hpLedmDirectProbe(3068)
      api.expect(direct.ok, '直连探测应至少一通道应答（LEDM :8080 系或 CDM 系）')
      api.expect(direct.status === 'online', `ready 的 StatusCategory=ready 应映射 online（实际 ${direct.status}）`)
      api.expect(direct.rawCategory === 'ready', `原始 StatusCategory 应 ready（实际 ${direct.rawCategory}）`)
      api.expect(direct.consumables.length === 4, `LEDM ConsumableConfigDyn 应解析 4 色墨（实际 ${direct.consumables.length}）`)
      const black = direct.consumables.find((c) => c.color === '黑色')
      api.expect(black !== undefined && black.levelPct === 62, `黑色墨应 62%（实际 ${black?.levelPct}）`)
      api.expect(direct.trays !== null && direct.trays.length === 3, `MediaHandlingDyn 应解析 3 纸盒（实际 ${direct.trays?.join(',')}）`)
      api.expect(direct.hasAutoDuplexor === true, 'Accessories autoDuplexor 应为 true')
      api.step(
        '直连 LEDM/CDM 探测',
        `StatusCategory=${direct.rawCategory}，${direct.consumables.length} 色墨（黑 ${black?.levelPct}%），纸盒 ${direct.trays?.join('/') ?? '?'}，autoDuplexor=true`,
      )

      // ---------------------------------------------------------------- 2) 命名空间剥除验证（bare 风格：无前缀 XML 同样解析——HPLIP 剥前缀逻辑的宽容面）
      await api.httpProbe('POST', '/api/vledm/style', { body: { style: 'bare' } })
      const bare = await api.hpLedmDirectProbe(3068)
      api.expect(bare.ok && bare.consumables.length === 4, `bare 无命名空间 XML 应同样解析 4 色墨（实际 ${bare.consumables.length}）`)
      api.expect(bare.trays !== null && bare.trays.length === 3, 'bare 纸盒解析应一致（宽容：前缀可选）')
      api.step('命名空间剥除验证', 'bare 风格（无 psdyn:/ccdyn:/mhdyn: 前缀）解析结果与 namespaced 一致')

      // ---------------------------------------------------------------- 3) 启用 HP 探测（真实 settings 路由 + 端口校验）
      const prevSettings = await api.httpProbe('GET', '/api/settings')
      const prevHp = (prevSettings.json?.settings as { hpLedmProbeEnabled?: boolean; hpLedmPort?: number; hpCdmPort?: number } | undefined) ?? {}
      const enableRes = await api.httpProbe('PATCH', '/api/settings', { body: { hpLedmProbeEnabled: true, hpLedmPort: 3068, hpCdmPort: 3068 } })
      if (enableRes.status !== 200) throw new ScenarioFailure(`启用 HP 探测应 200（实际 ${enableRes.status}：${enableRes.bodyText.slice(0, 120)}）`)
      api.step('启用 HP 探测（settings）', 'hpLedmProbeEnabled=true，LEDM/CDM 端口均指向 :3068（真实 PATCH 路由 + 1-65535 校验）')
      // 非法端口应 400（校验路径）
      const badPort = await api.httpProbe('PATCH', '/api/settings', { body: { hpLedmPort: 99999 } })
      api.expect(badPort.status === 400, `hpLedmPort=99999 应 400（实际 ${badPort.status}）`)

      // 还原 bare → namespaced（后续融合验证用真实同款风格）
      await api.httpProbe('POST', '/api/vledm/style', { body: { style: 'namespaced' } })

      try {
        // ------------------------------------------------------------ 4) 导入 vipp-basic 打印机（IPP 无耗材/纸盒 → HP 是 VENDOR_API 兑底来源）
        const printer = await api.importFromUri('ipp', 'ipp://127.0.0.1:3061/printers/vipp-basic')
        api.step('导入 vipp-basic', `${printer.name}（backendUri=${printer.backendUri}，HP 探测目标 127.0.0.1:3068；IPP 无 marker-* 耗材 → VENDOR_API 兑底）`)

        // ------------------------------------------------------------ 5) 刷新能力：VENDOR_API 探测 + 耗材/纸盒/双面融合
        const refresh1 = await api.httpProbe('POST', `/api/printers/${printer.id}/refresh-capabilities`)
        if (refresh1.status !== 200) throw new ScenarioFailure(`刷新能力应 200（实际 ${refresh1.status}）`)
        const report1 = (refresh1.json?.report ?? printer.capabilityReport) as CapabilityReport | undefined
        api.expect(report1 !== undefined, '刷新后应返回能力报告')
        if (!report1) return
        const hpProbe = report1.probes.find((p) => p.source === 'VENDOR_API' && p.detail?.includes('HP LEDM/CDM') === true)
        api.expect(hpProbe !== undefined && hpProbe.ok === true, 'probes 应含成功的 HP LEDM/CDM 探测记录')
        api.expect(report1.consumables.state === 'supported', `HP 耗材应 supported（实际 ${report1.consumables.state}）`)
        const merged = report1.consumables.value ?? []
        api.expect(merged.length === 4, `融合后耗材应 4 项（实际 ${merged.length}）`)
        const mergedBlack = merged.find((c) => c.color === '黑色')
        api.expect(mergedBlack?.source === 'VENDOR_API' && mergedBlack.levelPct === 62, `黑色墨应 VENDOR_API 62%（实际 ${mergedBlack?.source}:${mergedBlack?.levelPct}）`)
        // 纸盒 + 双面（LEDM MediaHandlingDyn 新能力轴来源）
        api.expect(report1.paperTrays.state === 'supported', `纸盒应 supported（实际 ${report1.paperTrays.state}）`)
        api.expect((report1.paperTrays.value ?? []).join(',') === 'Tray1,Tray2,PhotoTray', `纸盒应为 Tray1/Tray2/PhotoTray（实际 ${report1.paperTrays.value?.join(',')}）`)
        api.expect(report1.duplex.state === 'supported', `双面应 supported（实际 ${report1.duplex.state}）`)
        api.step(
          '刷新能力（HP 融合）',
          `probes=${report1.probes.map((p) => `${p.source}:${p.ok ? 'ok' : 'fail'}`).join(' ')}，耗材 ${merged.length} 项（黑 ${mergedBlack?.levelPct}% VENDOR_API），纸盒 Tray1/Tray2/PhotoTray，双面 both`,
        )

        // ------------------------------------------------------------ 6) paper-out 状态融合（trayEmptyOrOpen → paper-out）
        await api.httpProbe('POST', '/api/vledm/condition', { body: { condition: 'paper-out' } })
        const refresh2 = await api.httpProbe('POST', `/api/printers/${printer.id}/refresh-capabilities`)
        const printer2 = api.getPrinter(printer.id)
        api.expect(refresh2.status === 200, 'paper-out 刷新应 200')
        api.expect(printer2.status === 'paper-out', `trayEmptyOrOpen 应融合为 paper-out（实际 ${printer2.status}）`)
        api.step('paper-out 状态融合', `StatusCategory=trayEmptyOrOpen → ${printer2.status}（${printer2.statusNote ?? ''}）`)

        // ------------------------------------------------------------ 7) toner-low 耗材联动（耗材域独立 + 状态保守守卫双重验证）
        await api.httpProbe('POST', '/api/vledm/condition', { body: { condition: 'toner-low' } })
        const refresh3 = await api.httpProbe('POST', `/api/printers/${printer.id}/refresh-capabilities`)
        const printer3 = api.getPrinter(printer.id)
        const report3 = (refresh3.json?.report ?? printer3.capabilityReport) as CapabilityReport | undefined
        api.expect(refresh3.status === 200, 'toner-low 刷新应 200')
        // 保守守卫：StatusCategory=ready 不会把已有 paper-out 融合回 online（与 IPP/SNMP 守卫同口径——错误状态只由后端状态同步恢复）
        api.expect(printer3.status === 'paper-out', `StatusCategory=ready 不应覆盖已有错误状态（保守守卫；实际 ${printer3.status}）`)
        const lowBlack = (report3?.consumables.value ?? []).find((c) => c.color === '黑色')
        api.expect(lowBlack?.levelPct === 8, `黑色墨应联动为 8%（实际 ${lowBlack?.levelPct}）`)
        api.step('toner-low 耗材联动', `状态保持 paper-out（ready 不覆盖错误状态——保守守卫同 IPP/SNMP 口径），黑色墨 62% → ${lowBlack?.levelPct}%（状态/耗材域分离）`)

        // ------------------------------------------------------------ 8) 全 404：探测失败 → UNKNOWN 兜底（能力三态红线）
        await api.httpProbe('POST', '/api/vledm/style', { body: { style: '404' } })
        const refresh4 = await api.httpProbe('POST', `/api/printers/${printer.id}/refresh-capabilities`)
        const printer4 = api.getPrinter(printer.id)
        const report4 = (refresh4.json?.report ?? printer4.capabilityReport) as CapabilityReport | undefined
        api.expect(refresh4.status === 200, '404 刷新应 200（探测失败不阻断）')
        // 红线：读不到 ≠ 不支持——全 unknown，绝不出现在 404 后把耗材变 unsupported
        api.expect(report4?.consumables.state !== 'unsupported', `404 后耗材绝不应为 unsupported（实际 ${report4?.consumables.state}）`)
        const failProbe = report4?.probes.find((p) => p.source === 'VENDOR_API')
        api.expect(failProbe?.ok === false, '404 后应保留失败的 VENDOR_API probe（含错误明细）')
        api.step('404 → UNKNOWN 兜底', `耗材 state=${report4?.consumables.state}（读不到≠不支持），probe 错误：${(failProbe?.error ?? '').slice(0, 80)}`)
      } finally {
        // ------------------------------------------------------------ 9) 清理：settings 还原 + 设备状态复位
        await api.httpProbe('POST', '/api/vledm/style', { body: { style: 'namespaced' } })
        await api.httpProbe('POST', '/api/vledm/condition', { body: { condition: 'ready' } })
        await api.httpProbe('PATCH', '/api/settings', {
          body: {
            hpLedmProbeEnabled: prevHp.hpLedmProbeEnabled === true,
            hpLedmPort: prevHp.hpLedmPort ?? 8080,
            hpCdmPort: prevHp.hpCdmPort ?? 80,
          },
        })
        api.step('settings 还原', `hpLedmProbeEnabled=${prevHp.hpLedmProbeEnabled === true}，LEDM=${prevHp.hpLedmPort ?? 8080}，CDM=${prevHp.hpCdmPort ?? 80}`)
      }
    },
  },
]
