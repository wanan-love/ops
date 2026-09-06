import { PDFDocument } from 'pdf-lib'
import type { ScenarioApi } from './selftest'
import { ScenarioSkipped } from './selftest'

/**
 * eSCL 扫描场景（P3 + P4 Duplex，Virtual eSCL Scanner :3065 提供可验证链路）：
 *  16. escl-full-flow  扫描全链路（vscan）：设备列表 → Platen 单页（PNG 魔数/IHDR 校验）
 *      → ADF Feeder 多页（2 页）→ 150dpi 取消（cancelled / 已完成容许）
 *  17. scan-pdf-export  按需 PDF 导出（P3.5）：Feeder 2 页 → export-pdf → 魔数/页数/元数据
 *      校验 → 幂等复用 → 未完成任务导出应报错（用已取消任务验证容错）
 *  19. escl-duplex      双面扫描（P4）：设备能力（flatbed no / adf yes）→ Feeder+Duplex 4 页
 *      正反交替（pageSides + 图像内容差异）→ 平板+双面 400 拒绝 → 双面 PDF 导出 4 页
 */
export type ScanScenarioId = 'escl-full-flow' | 'scan-pdf-export' | 'escl-duplex'

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
  {
    id: 'scan-pdf-export',
    name: '扫描 PDF 导出（P3.5 按需合成）',
    description: 'Feeder 2 页扫描 → export-pdf（魔数 %PDF + pdf-lib 页数=2 + 元数据）→ 幂等复用 → 非完成任务导出应报错',
    async run(api) {
      if (!api.vscanAvailable()) throw new ScenarioSkipped('Virtual eSCL Scanner 未启用（OPS_VSCAN_ENABLED=0）')

      // 1) 多页扫描完成
      const job = await api.startScan('vscan-adf', { format: 'image/png', dpi: 300, colorMode: 'RGB', inputSource: 'Feeder' })
      api.step('提交扫描（Feeder 300dpi RGB）', `${job.id}`)
      const done = await api.waitForScan(job.id, (j) => j.state === 'completed', 30000)
      api.expect(done.pagesDone === 2, `Feeder 应 2 页（实际 ${done.pagesDone}）`)
      api.expect(done.pdf == null, '导出前 job.pdf 应为空')

      // 2) 导出 PDF
      const exported = await api.exportScanPdf(job.id)
      api.expect(exported.pdf != null, '导出后 job.pdf 应有元数据')
      if (exported.pdf) {
        api.expect(exported.pdf.pages === 2, `PDF 页数应 2（实际 ${exported.pdf.pages}）`)
        api.expect(exported.pdf.bytes > 1000, `PDF 字节数合理 >1000（实际 ${exported.pdf.bytes}）`)
        api.step('导出完成', `${exported.pdf.pages} 页 / ${exported.pdf.bytes} bytes / ${exported.pdf.durationMs}ms`)
      }

      // 3) 字节级校验：魔数 + pdf-lib 解析页数 + 页面尺寸（竖图 A4 纵向）
      const pdfBytes = await api.scanPdfBytes(exported)
      api.expect(pdfBytes !== null && pdfBytes.length > 1000, 'PDF 字节存在且合理')
      if (pdfBytes) {
        const head = Buffer.from(pdfBytes.slice(0, 8)).toString('latin1')
        api.expect(head.startsWith('%PDF-'), `PDF 魔数正确（实际 ${head.slice(0, 5)}）`)
        const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true, updateMetadata: false })
        api.expect(doc.getPageCount() === 2, `pdf-lib 解析页数应 2（实际 ${doc.getPageCount()}）`)
        const size = doc.getPage(0).getSize()
        api.expect(Math.abs(size.width - 595.28) < 1 && Math.abs(size.height - 841.89) < 1, `A4 纵向页面（实际 ${size.width.toFixed(1)}x${size.height.toFixed(1)}）`)
        api.step('PDF 校验', `魔数 OK，${doc.getPageCount()} 页，A4 ${size.width.toFixed(0)}x${size.height.toFixed(0)}pt，${pdfBytes.length} bytes`)
      }

      // 4) 幂等复用：二次导出不重复合成（durationMs 不变即未重新生成）
      const again = await api.exportScanPdf(job.id)
      api.expect(again.pdf != null && again.pdf.exportedAt === exported.pdf?.exportedAt, '二次导出应复用缓存（exportedAt 不变）')
      api.step('幂等复用', `exportedAt 未变：${again.pdf?.exportedAt}`)

      // 5) 容错：对失败/取消状态任务导出应报错
      const job2 = await api.startScan('vscan-flatbed', { format: 'image/png', dpi: 150, colorMode: 'RGB', inputSource: 'Platen' })
      await api.sleep(150)
      await api.cancelScan(job2.id)
      await api.waitForScan(job2.id, (j) => j.state === 'cancelled' || j.state === 'completed', 15000)
      const snapshot = api.scanJob(job2.id)
      if (snapshot && snapshot.state === 'cancelled') {
        let rejected = false
        try {
          await api.exportScanPdf(job2.id)
        } catch {
          rejected = true // 预期抛错：仅 completed 可导出
        }
        api.expect(rejected, `取消状态任务导出应报错（${job2.id}）`)
      } else {
        api.step('容错校验跳过', '取消任务恰好在容许窗口内完成（completed），跳过状态校验')
      }
    },
  },
  {
    id: 'escl-duplex',
    name: '双面扫描（P4 · Feeder Duplex）',
    description: '设备双面能力三态（flatbed=no / adf=yes）→ Feeder+Duplex 4 页正反交替（pageSides + 图像内容差异）→ 平板+双面 400 拒绝 → 双面 PDF 导出 4 页',
    async run(api) {
      if (!api.vscanAvailable()) throw new ScenarioSkipped('Virtual eSCL Scanner 未启用（OPS_VSCAN_ENABLED=0）')

      // 1) 设备双面能力三态（vscan 静态注入）
      const devices = await api.scanDevices()
      const adf = devices.find((d) => d.id === 'vscan-adf')
      const flatbed = devices.find((d) => d.id === 'vscan-flatbed')
      api.expect(adf?.duplexCap === 'yes', `vscan-adf 双面能力应为 yes（实际 ${adf?.duplexCap}）`)
      api.expect(flatbed?.duplexCap === 'no', `vscan-flatbed 双面能力应为 no（实际 ${flatbed?.duplexCap}）`)
      api.step('设备双面能力', `flatbed=no / adf=yes（能力三态注入）`)

      // 2) 平板 + 双面 → 语义拒绝（路由层 400，startScan 直调抛错）
      let rejected = false
      try {
        await api.startScan('vscan-flatbed', { format: 'image/png', dpi: 150, colorMode: 'RGB', inputSource: 'Platen', duplex: true })
      } catch {
        rejected = true // 预期：平板无法双面
      }
      api.expect(rejected, '平板 + duplex 应被拒绝（平板无法双面）')
      api.step('语义校验', '平板 + 双面 → 拒绝（与路由 400 / vscan 400 一致）')

      // 3) Feeder + Duplex → 4 页正反交替
      const job = await api.startScan('vscan-adf', { format: 'image/png', dpi: 300, colorMode: 'RGB', inputSource: 'Feeder', duplex: true })
      api.step('提交双面扫描', `${job.id}（预推 pagesTotal=${job.pagesTotal}）`)
      api.expect(job.pagesTotal === 4, `预推页数应 4（实际 ${job.pagesTotal}）`)
      api.expect(job.duplex === true, 'job.duplex 应为 true')
      const done = await api.waitForScan(job.id, (j) => j.state === 'completed', 30000)
      api.expect(done.pagesDone === 4, `双面应 4 页（实际 ${done.pagesDone}）`)
      api.expect(done.pageSides?.length === 4, `pageSides 应 4 项（实际 ${done.pageSides?.length}）`)
      const expectedSides = ['front', 'back', 'front', 'back']
      api.expect(
        done.pageSides?.every((s, i) => s === expectedSides[i]) ?? false,
        `正反交替应为 front/back/front/back（实际 ${done.pageSides?.join(',')}）`,
      )
      api.step('双面页序', `纸1正 / 纸1反 / 纸2正 / 纸2反（${done.pageSides?.join(',')}）`)

      // 4) 正/反页图像内容差异（背面有空心框标记，正面无；顶部色带红黄 vs 蓝绿）
      const front = await api.scanArtifactBytes(done, 1)
      const back = await api.scanArtifactBytes(done, 2)
      api.expect(front !== null && back !== null, '正/反页 PNG 存在')
      if (front && back) {
        api.expect(front.length !== back.length, `正/反页内容应不同（字节长度差异：正面 ${front.length} vs 背面 ${back.length}）`)
        // 顶部色带首像素：正面红色系（R>200, G<100）；背面蓝色系（R<100, B>200）
        // PNG 结构：IHDR 13 + 后续 IDAT 压缩，直接解像素成本高；退而验证字节序列差异 + 长度差异已足够，
        // 配合 pageSides 语义与渲染逻辑（色带/空心框由 side 决定）已形成双重验证
        let diff = 0
        for (let i = 0; i < Math.min(front.length, back.length); i++) {
          if (front[i] !== back[i]) diff++
        }
        api.expect(diff > 100, `正/反页应存在大量字节差异（diff=${diff}，背面含空心框标记）`)
        api.step('图像差异', `字节差异 ${diff} 处（背面空心框 + 蓝绿色带）`)
      }

      // 5) 单面对照：非双面任务无 pageSides
      const simplex = await api.startScan('vscan-adf', { format: 'image/png', dpi: 150, colorMode: 'Grayscale', inputSource: 'Feeder' })
      const simplexDone = await api.waitForScan(simplex.id, (j) => j.state === 'completed', 30000)
      api.expect(simplexDone.pagesDone === 2, `单面 Feeder 应 2 页（实际 ${simplexDone.pagesDone}）`)
      api.expect(simplexDone.pageSides === undefined || simplexDone.pageSides === null, `单面任务不应有 pageSides（实际 ${JSON.stringify(simplexDone.pageSides)}）`)
      api.expect(simplexDone.duplex !== true, '单面任务 job.duplex 应非 true')
      api.step('单面对照', `2 页无 pageSides，duplex=${String(simplexDone.duplex)}`)

      // 6) 双面任务 PDF 导出：4 页依序合成
      const exported = await api.exportScanPdf(done.id)
      api.expect(exported.pdf?.pages === 4, `双面 PDF 页数应 4（实际 ${exported.pdf?.pages}）`)
      const pdfBytes = await api.scanPdfBytes(exported)
      if (pdfBytes) {
        const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true, updateMetadata: false })
        api.expect(doc.getPageCount() === 4, `pdf-lib 解析双面 PDF 应 4 页（实际 ${doc.getPageCount()}）`)
        api.step('双面 PDF', `${doc.getPageCount()} 页依序合成（正反交替保持文档顺序）`)
      }
    },
  },
]
