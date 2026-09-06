import type { ScenarioApi } from './selftest'
import { ScenarioSkipped } from './selftest'

/**
 * eSCL 扫描场景（P3，Virtual eSCL Scanner :3065 提供可验证链路）：
 *  16. escl-full-flow  扫描全链路（vscan）：设备列表 → Platen 单页（PNG 魔数/IHDR 校验）
 *      → ADF Feeder 多页（2 页）→ 150dpi 取消（cancelled / 已完成容许）
 */
export type ScanScenarioId = 'escl-full-flow'

export interface ScanScenario {
  id: ScanScenarioId
  name: string
  description: string
  run(api: ScenarioApi): Promise<void>
}

export const scanScenarios: ScanScenario[] = [
  {
    id: 'escl-full-flow',
    name: 'eSCL 扫描全链路（vscan）',
    description: '设备列表（vscan-flatbed/adf）→ Platen 单页 PNG（魔数 + IHDR 850x1100）→ ADF Feeder 2 页 → 150dpi 取消',
    async run(api) {
      if (!api.vscanAvailable()) throw new ScenarioSkipped('Virtual eSCL Scanner 未启用（OPS_VSCAN_ENABLED=0）')
      const devices = await api.scanDevices()
      api.step('设备列表', `${devices.length} 台：${devices.map((d) => d.name).join('、')}`)
      api.expect(devices.some((d) => d.id === 'vscan-flatbed'), '应含 vscan-flatbed')
      api.expect(devices.some((d) => d.id === 'vscan-adf'), '应含 vscan-adf')

      // Platen 单页（300dpi RGB）
      const job1 = await api.startScan('vscan-flatbed', { format: 'image/png', dpi: 300, colorMode: 'RGB', inputSource: 'Platen' })
      api.step('提交扫描（Platen 300dpi RGB）', `${job1.id}`)
      const done1 = await api.waitForScan(job1.id, (j) => j.state === 'completed', 30000)
      api.expect(done1.pagesDone === 1, `Platen 应 1 页（实际 ${done1.pagesDone}）`)
      api.expect(done1.pagesTotal === 1, `完成后 pagesTotal 应等于实际页数（实际 ${done1.pagesTotal}）`)
      const bytes = await api.scanArtifactBytes(done1, 1)
      api.expect(bytes !== null && bytes.length > 1000, 'PNG 字节数合理（>1000）')
      if (bytes) {
        api.expect(bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47, 'PNG 魔数正确（89 50 4E 47）')
        // IHDR 宽高（字节 16-23，big endian）
        const w = (bytes[16]! * 0x1000000 + bytes[17]! * 0x10000 + bytes[18]! * 0x100 + bytes[19]!) >>> 0
        const h = (bytes[20]! * 0x1000000 + bytes[21]! * 0x10000 + bytes[22]! * 0x100 + bytes[23]!) >>> 0
        api.expect(w === 850 && h === 1100, `IHDR 850x1100（实际 ${w}x${h}）`)
        api.step('PNG 校验', `魔数 OK，IHDR ${w}x${h}，${bytes.length} bytes`)
      }

      // ADF 多页（Feeder → 2 页，Grayscale）
      const job2 = await api.startScan('vscan-adf', { format: 'image/png', dpi: 300, colorMode: 'Grayscale', inputSource: 'Feeder' })
      api.step('提交扫描（Feeder 300dpi Grayscale）', `${job2.id}`)
      const done2 = await api.waitForScan(job2.id, (j) => j.state === 'completed', 30000)
      api.expect(done2.pagesDone === 2, `Feeder 应 2 页（实际 ${done2.pagesDone}）`)
      const b2 = await api.scanArtifactBytes(done2, 2)
      api.expect(b2 !== null && b2.length > 1000, '第 2 页 PNG 存在且字节数合理')
      if (b2) {
        api.expect(b2[0] === 0x89 && b2[1] === 0x50 && b2[2] === 0x4e && b2[3] === 0x47, '第 2 页 PNG 魔数正确')
      }

      // 取消（150dpi，readyAt 前取消 → cancelled；若恰好已完成则容许 completed）
      const job3 = await api.startScan('vscan-flatbed', { format: 'image/png', dpi: 150, colorMode: 'RGB', inputSource: 'Platen' })
      api.step('提交扫描（150dpi，准备取消）', `${job3.id}`)
      await api.sleep(200)
      const cancelled = await api.cancelScan(job3.id)
      api.expect(cancelled.state === 'cancelled' || cancelled.state === 'completed', `取消后状态应为 cancelled（已完成场景容许 completed，实际 ${cancelled.state}）`)
      const final3 = await api.waitForScan(job3.id, (j) => j.state !== 'scanning' && j.state !== 'pending', 15000)
      api.expect(final3.finishedAt !== null, '取消/完成后应记录 finishedAt')
      api.step('取消验证完成', `state=${final3.state}，已取 ${final3.pagesDone}/${final3.pagesTotal} 页`)
    },
  },
]
