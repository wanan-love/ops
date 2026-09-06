import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

/** 生成示例 PDF（演示/测试打印用，不依赖任何外部文件；标准字体仅支持 WinAnsi，故正文为 ASCII） */
export async function makeSamplePdf(pages = 2, title = 'OpenPrintShare Demo Document'): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.setTitle('OpenPrintShare Demo')
  doc.setProducer('OpenPrintShare Virtual Printer')
  const font = await doc.embedFont(StandardFonts.HelveticaBold)
  const sub = await doc.embedFont(StandardFonts.Helvetica)
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19)
  const safeTitle = title.replace(/[^\x20-\x7E]/g, '?')

  for (let i = 1; i <= pages; i++) {
    const page = doc.addPage([595.28, 841.89]) // A4
    const { width, height } = page.getSize()
    page.drawRectangle({ x: 36, y: 36, width: width - 72, height: height - 72, borderColor: rgb(0.1, 0.6, 0.45), borderWidth: 1.5 })
    page.drawText('OpenPrintShare', { x: 52, y: height - 90, size: 26, font, color: rgb(0.02, 0.45, 0.35) })
    page.drawText(safeTitle, { x: 52, y: height - 122, size: 14, font: sub, color: rgb(0.35, 0.35, 0.35) })
    page.drawText(`Generated: ${now} (UTC) - Virtual Printer demo`, { x: 52, y: height - 142, size: 9, font: sub, color: rgb(0.55, 0.55, 0.55) })
    page.drawLine({ start: { x: 52, y: height - 160 }, end: { x: width - 52, y: height - 160 }, thickness: 0.75, color: rgb(0.8, 0.8, 0.8) })

    // 模拟正文行
    for (let line = 0; line < 18; line++) {
      const y = height - 200 - line * 26
      const w = 300 + ((line * 137) % 180)
      page.drawRectangle({ x: 52, y, width: w, height: 9, color: rgb(0.87, 0.89, 0.88) })
    }

    page.drawText(`Page ${i} / ${pages}`, { x: width / 2 - 40, y: 52, size: 9, font: sub, color: rgb(0.5, 0.5, 0.5) })
    page.drawText('Virtual Printer simulated output - MockPrinterBackend', { x: 52, y: 52, size: 7, font: sub, color: rgb(0.65, 0.65, 0.65) })
  }
  return doc.save()
}

/** 用 pdf-lib 精确解析页数（失败时返回 null，调用方退回正则估算） */
export async function exactPageCount(bytes: Uint8Array): Promise<number | null> {
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })
    return Math.max(1, doc.getPageCount())
  } catch {
    return null
  }
}

/** PDF 魔数校验 */
export function isPdf(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.slice(0, 1024)).toString('latin1')
  return head.startsWith('%PDF-')
}
