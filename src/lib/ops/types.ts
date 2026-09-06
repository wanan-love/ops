/**
 * OpenPrintShare — OPS/1.0 协议 DTO（客户端侧契约，与服务端 core/types 对应）
 */

export type Platform = 'windows' | 'macos' | 'linux' | 'android' | 'ios' | 'web'
export type BackendKind = 'mock' | 'windows' | 'cups' | 'android' | 'airprint'

export type PrinterStatus = 'online' | 'busy' | 'offline' | 'paper-out' | 'paper-jam' | 'error'
export type JobState = 'pending' | 'processing' | 'paused' | 'completed' | 'failed' | 'cancelled'

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
  virtual: boolean
  shared: boolean
  status: PrinterStatus
  statusMessage: string
  ink: InkLevels
  capabilities: PrinterCapabilities
  defaultOptions: PrintOptions
  speedOverridePpm: number | null
  stats: PrinterStats
  test?: boolean
  activeJobId?: string | null
  createdAt: string
  updatedAt: string
}

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
  sheetsTotal: number
  options: PrintOptions
  state: JobState
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

export interface HostInfo {
  service: string
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

export interface StorageStats {
  files: number
  bytes: number
  jobs: number
  testRuns: number
  pdfBytes: number
}

export interface SystemStats {
  jobs: Record<string, number>
  storage: StorageStats
  printers: Array<{ id: string; name: string; status: PrinterStatus; stats: PrinterStats; shared: boolean }>
  backends: Array<{ kind: BackendKind; available: boolean; note: string }>
}

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

export const PRINTER_STATUS_LABEL: Record<PrinterStatus, string> = {
  online: '在线 · 就绪',
  busy: '打印中',
  offline: '离线',
  'paper-out': '缺纸',
  'paper-jam': '卡纸',
  error: '错误',
}

export const JOB_STATE_LABEL: Record<JobState, string> = {
  pending: '排队中',
  processing: '打印中',
  paused: '已暂停',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

export const OPS_VERSION = '0.1.0'
