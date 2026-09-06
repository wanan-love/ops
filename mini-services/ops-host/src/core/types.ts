/**
 * OpenPrintShare — Core Domain Types
 * 平台无关：此文件不允许 import 任何平台 API / 运行时依赖。
 * Web 控制台通过 tsconfig path alias (@ops-core/*) 复用此契约。
 */

export const OPS_VERSION = '0.1.0'
export const OPS_API_VERSION = 1

/** 客户端平台标识 */
export type Platform = 'windows' | 'macos' | 'linux' | 'android' | 'ios' | 'web'

/** 打印后端种类（可插拔，MVP 使用 mock） */
export type BackendKind = 'mock' | 'windows' | 'cups' | 'android' | 'airprint'

/** 打印机状态（mock 引擎与真实后端共用语义） */
export type PrinterStatus =
  | 'online'    // 在线/就绪
  | 'busy'      // 打印中
  | 'offline'   // 离线
  | 'paper-out' // 缺纸
  | 'paper-jam' // 卡纸
  | 'error'     // 打印机错误（含墨尽）

/** 打印任务状态 */
export type JobState =
  | 'pending'    // 排队中
  | 'processing' // 打印中
  | 'paused'     // 暂停（缺纸/卡纸/离线/Host 重启等）
  | 'completed'  // 已完成
  | 'failed'     // 失败
  | 'cancelled'  // 已取消

export interface InkLevels {
  cyan: number
  magenta: number
  yellow: number
  black: number
}

export interface PrinterCapabilities {
  color: boolean
  duplex: 'none' | 'long-edge' | 'short-edge' | 'both'
  maxCopies: number
  paperSizes: string[]
  maxResolutionDpi: number
  /** 标称速度（页/分钟，虚拟打印机即可调模拟速度） */
  ppm: number
}

export interface PrintOptions {
  paperSize: string
  colorMode: 'color' | 'monochrome'
  duplex: 'none' | 'long-edge' | 'short-edge'
  copies: number
  quality: 'draft' | 'normal' | 'high'
  pageRange?: string
}

export interface JobSource {
  deviceId: string
  deviceName: string
  platform: Platform
}

export interface PrinterStats {
  submitted: number
  completed: number
  failed: number
  cancelled: number
  sheets: number
}

export interface Printer {
  id: string
  name: string
  description: string
  location: string
  backend: BackendKind
  /** Virtual Printer（不连接物理设备，接收 PDF 并模拟完整打印流程） */
  virtual: boolean
  shared: boolean
  status: PrinterStatus
  statusMessage: string
  ink: InkLevels
  capabilities: PrinterCapabilities
  defaultOptions: PrintOptions
  /** 调试覆盖速度（ppm），null = 使用标称速度 */
  speedOverridePpm: number | null
  stats: PrinterStats
  /** Self-Test 场景创建的隔离打印机 */
  test?: boolean
  createdAt: string
  updatedAt: string
}

/** 任务时间线（状态变化记录） */
export interface TimelineEntry {
  at: string
  type: 'state' | 'progress' | 'condition' | 'printer' | 'system'
  from?: JobState
  to?: JobState
  progress?: number
  message?: string
  reason?: string
}

export interface PrintJob {
  id: string
  printerId: string
  source: JobSource
  fileName: string
  sizeBytes: number
  pageCount: number
  /** 总纸张数 = 页数 × 份数 /（双面 ÷2，向上取整） */
  sheetsTotal: number
  options: PrintOptions
  state: JobState
  /** 0–100 */
  progress: number
  error: string | null
  timeline: TimelineEntry[]
  submittedAt: string
  startedAt: string | null
  endedAt: string | null
  printedSheets: number
  inkUsed: InkLevels
  test?: boolean
}

/** 模拟打印结果（落盘 result.json） */
export interface PrintResult {
  jobId: string
  outcome: 'success' | 'failed' | 'cancelled'
  message: string
  startedAt: string | null
  completedAt: string
  durationMs: number
  sheets: number
  inkUsed: InkLevels
  options: PrintOptions
  document: string
}

export interface HostSettings {
  hostId: string
  hostName: string
  securityMode: 'open' | 'pairing'
}

export interface PairedDevice {
  deviceId: string
  name: string
  platform: Platform
  token: string
  pairedAt: string
  lastSeenAt: string
}

export interface PairingRequest {
  id: string
  deviceId: string
  deviceName: string
  platform: Platform
  code: string
  status: 'pending' | 'approved' | 'rejected'
  createdAt: string
  resolvedAt: string | null
}

export interface DiscoveredHost {
  hostId: string
  hostName: string
  version: string
  apiVersion: number
  restPort: number
  platform: Platform
  printers: number
  sharedPrinters: number
  addr: string
  source: 'self' | 'beacon' | 'manual'
  lastSeenAt: string
}

export interface OpsEvent {
  id: string
  at: string
  type: 'job' | 'printer' | 'pairing' | 'host' | 'test' | 'security' | 'discovery'
  topic: string
  message: string
  data?: Record<string, unknown>
}

export interface TestStep {
  name: string
  detail: string
  ok: boolean
  at: string
}

export interface ScenarioResult {
  id: string
  name: string
  description: string
  status: 'pass' | 'fail' | 'error' | 'skipped'
  durationMs: number
  steps: TestStep[]
  error?: string
}

export interface TestRun {
  runId: string
  startedAt: string
  finishedAt: string | null
  status: 'running' | 'done'
  total: number
  passed: number
  failed: number
  results: ScenarioResult[]
}

export interface HostInfo {
  service: 'openprintshare-host'
  hostId: string
  hostName: string
  version: string
  apiVersion: number
  platform: Platform
  platformNote: string
  backend: BackendKind
  uptimeSec: number
  securityMode: 'open' | 'pairing'
  restPort: number
  wsPort: number
  dataDir: string
}
