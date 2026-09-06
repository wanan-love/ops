import { promises as fs } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { OpsEvent } from './types'

/**
 * 文件型 Storage（Spool 目录）。
 * 一切运行时工件都落在 dataDir，宿主机重启后可完整恢复：
 *  - printers.json            打印机注册表（状态/墨量/统计）
 *  - settings.json            Host 设置
 *  - devices.json             已配对设备
 *  - pairing.json             配对请求
 *  - jobs/{id}/job.json       PrintJob + PrintOptions + 状态时间线
 *  - jobs/{id}/document.pdf   原始 PDF
 *  - jobs/{id}/result.json    模拟打印结果
 *  - events.jsonl             全局状态变化记录
 *  - test-runs/{runId}.json   自动化测试结果
 */
export class FileStorage {
  readonly dataDir: string

  constructor(dataDir: string) {
    this.dataDir = resolve(dataDir)
  }

  async init(): Promise<void> {
    for (const dir of ['.', 'jobs', 'test-runs']) {
      await fs.mkdir(join(this.dataDir, dir), { recursive: true })
    }
  }

  path(rel: string): string {
    return join(this.dataDir, rel)
  }

  async readJson<T>(rel: string, fallback: T): Promise<T> {
    try {
      const raw = await fs.readFile(this.path(rel), 'utf8')
      return JSON.parse(raw) as T
    } catch {
      return fallback
    }
  }

  /** 原子写（唯一 tmp 名 + rename），避免并发写同一文件时 rename 竞争 */
  async writeJson(rel: string, data: unknown): Promise<void> {
    const full = this.path(rel)
    await fs.mkdir(dirname(full), { recursive: true })
    const tmp = `${full}.${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.tmp`
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
    await fs.rename(tmp, full)
  }

  async exists(rel: string): Promise<boolean> {
    try {
      await fs.access(this.path(rel))
      return true
    } catch {
      return false
    }
  }

  async remove(rel: string): Promise<void> {
    await fs.rm(this.path(rel), { recursive: true, force: true })
  }

  // ---- Jobs ----

  jobDir(jobId: string): string {
    return join(this.dataDir, 'jobs', jobId)
  }

  async saveJobDocument(jobId: string, bytes: Uint8Array): Promise<string> {
    const dir = this.jobDir(jobId)
    await fs.mkdir(dir, { recursive: true })
    const doc = join(dir, 'document.pdf')
    await fs.writeFile(doc, bytes)
    return doc
  }

  async readJobDocument(jobId: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(join(this.jobDir(jobId), 'document.pdf'))
    } catch {
      return null
    }
  }

  async listJobIds(): Promise<string[]> {
    try {
      const entries = await fs.readdir(join(this.dataDir, 'jobs'), { withFileTypes: true })
      return entries.filter((e) => e.isDirectory()).map((e) => e.name)
    } catch {
      return []
    }
  }

  // ---- Events (jsonl 追加) ----

  async appendEvent(event: OpsEvent): Promise<void> {
    const line = JSON.stringify(event) + '\n'
    await fs.appendFile(this.path('events.jsonl'), line, 'utf8')
  }

  async readEventLines(limit: number): Promise<OpsEvent[]> {
    try {
      const raw = await fs.readFile(this.path('events.jsonl'), 'utf8')
      const lines = raw.split('\n').filter(Boolean)
      return lines
        .slice(-limit)
        .map((l) => JSON.parse(l) as OpsEvent)
        .reverse()
    } catch {
      return []
    }
  }

  // ---- Test runs ----

  async listTestRunIds(): Promise<string[]> {
    try {
      const entries = await fs.readdir(join(this.dataDir, 'test-runs'), { withFileTypes: true })
      return entries.filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => e.name.replace(/\.json$/, ''))
    } catch {
      return []
    }
  }

  // ---- 目录统计 / 清理 ----

  async stats(): Promise<{ files: number; bytes: number; jobs: number; testRuns: number; pdfBytes: number }> {
    let files = 0
    let bytes = 0
    let jobs = 0
    let testRuns = 0
    let pdfBytes = 0
    const walk = async (dir: string): Promise<void> => {
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(full)
        } else {
          files += 1
          const stat = await fs.stat(full).catch(() => null)
          if (stat) {
            bytes += stat.size
            if (entry.name === 'document.pdf') pdfBytes += stat.size
          }
        }
      }
    }
    await walk(join(this.dataDir, 'jobs'))
    jobs = (await this.listJobIds()).length
    const runs = await this.listTestRunIds()
    testRuns = runs.length
    for (const run of runs) {
      const stat = await fs.stat(this.path(`test-runs/${run}.json`)).catch(() => null)
      if (stat) {
        files += 1
        bytes += stat.size
      }
    }
    return { files, bytes, jobs, testRuns, pdfBytes }
  }

  async clearTestRuns(): Promise<number> {
    const ids = await this.listTestRunIds()
    for (const id of ids) {
      await fs.rm(this.path(`test-runs/${id}.json`), { force: true })
    }
    return ids.length
  }
}
