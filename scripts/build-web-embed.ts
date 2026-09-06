/**
 * 生成 Web 嵌入清单（mini-services/ops-host/src/generated/web-embed.ts）
 *
 * 扫描 Next.js 静态导出目录（默认 ../../out，即仓库根 out/），为每个文件生成
 * `import ... with { type: 'file' }`，映射「Web 路径 → Bun 编译虚拟路径」。
 * bun build --compile 后资产嵌入二进制 → 真·单文件可执行（用户无需解压 web/ 目录）。
 *
 * Bun 行为（1.3.x 实测）：
 *  - compile：import 返回 "/$bunfs/root/<hash>.<ext>"，Bun.file(p).text() 读嵌入内容
 *  - dev：import 返回磁盘真实路径，同样可读
 *
 * 用法：bun scripts/build-web-embed.ts [webDir=../../out]
 * 生成的文件已加入 .gitignore（构建产物）。
 */
import { promises as fs } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'

const webDir = resolve(process.argv[2] ?? '../../out')
const outFile = resolve(import.meta.dir, '../mini-services/ops-host/src/generated/web-embed.ts')

async function walk(dir: string, base = ''): Promise<Array<{ webPath: string; abs: string }>> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const files: Array<{ webPath: string; abs: string }> = []
  for (const e of entries) {
    const abs = join(dir, e.name)
    const webPath = `${base}/${e.name}`
    if (e.isDirectory()) files.push(...(await walk(abs, webPath)))
    else files.push({ webPath, abs })
  }
  return files
}

const files = await walk(webDir)
files.sort((a, b) => a.webPath.localeCompare(b.webPath))

// 跳过 Next 导出的 RSC payload txt 与 404（SPA 不需要）；保留 html/js/css/svg 等
const included = files.filter((f) => !f.webPath.endsWith('.txt'))

const importLines: string[] = []
const mapEntries: string[] = []
included.forEach((f, i) => {
  const id = `f${i}`
  const rel = relative(dirname(outFile), f.abs).replaceAll('\\', '/')
  importLines.push(`import ${id} from '${rel}' with { type: 'file' }`)
  mapEntries.push(`  ${JSON.stringify(f.webPath)}: ${id},`)
})

const banner = `// 自动生成（scripts/build-web-embed.ts）——构建产物，勿手动编辑/提交
// Web 控制台静态资产嵌入清单（${included.length} 个文件，源：${relative(dirname(outFile), webDir)}）
import type {} from 'bun'

${importLines.join('\n')}

export const EMBEDDED_WEB: Record<string, string> = {
${mapEntries.join('\n')}
}
`

await fs.mkdir(dirname(outFile), { recursive: true })
await fs.writeFile(outFile, banner)
console.log(`[web-embed] ${included.length} files → ${relative(resolve(outFile, '../..'), outFile)}`)
