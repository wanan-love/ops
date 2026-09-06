/**
 * OpenPrintShare — OPS/1.0 协议 DTO（客户端侧契约，与服务端 core/types 对应）
 */

export type Platform = 'windows' | 'macos' | 'linux' | 'android' | 'ios' | 'web'
export type BackendKind = 'mock' | 'windows' | 'cups' | 'ipp' | 'android' | 'airprint'

/** 能力三态：supported=确认支持 / unsupported=确认不支持 / unknown=未读取到（≠不支持） */
export type CapabilityState = 'supported' | 'unsupported' | 'unknown'
/** 能力数据来源 */
export type CapabilitySource = 'SYSTEM' | 'CUPS' | 'IPP' | 'WSD' | 'SNMP' | 'VENDOR_API' | 'UNKNOWN'

/** 能力四元组：value + state + source + timestamp */
export interface Capability<T> {
  value: T | null
  state: CapabilityState
  source: CapabilitySource
  timestamp: string
  detail?: string
}

/** 耗材信息（levelPct=null 表示未知，UI 应隐藏而不是显示假 0%） */
export interface ConsumableInfo {
  name: string
  kind: 'toner' | 'ink' | 'drum' | 'maintenance-kit' | 'other'
  color?: string
  levelPct: number | null
  source: CapabilitySource
}

/** 单个来源的探测记录（失败也保留，不影响其它能力） */
export interface CapabilityProbe {
  source: CapabilitySource
  ok: boolean
  durationMs: number
  error?: string
  at: string
}

export interface CapabilityReport {
  color: Capability<boolean>
  duplex: Capability<'none' | 'long-edge' | 'short-edge' | 'both'>
  maxCopies: Capability<number>
  paperSizes: Capability<string[]>
  maxResolutionDpi: Capability<number>
  ppm: Capability<number>
  consumables: Capability<ConsumableInfo[]>
  probes: CapabilityProbe[]
}

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
  backendKey?: string
  backendUri?: string
  capabilityReport?: CapabilityReport
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
  backendJobId?: string
  backendJobUri?: string
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
  backends?: BackendKind[]
  uptimeSec: number
  securityMode: 'open' | 'pairing'
  /** 控制台访问控制是否启用（公开信息，供客户端展示解锁界面） */
  consoleAuthEnabled?: boolean
  restPort: number
  wsPort: number
  dataDir: string
  /** 虚拟扫描服务（eSCL）端口（null = 未启用；开发/测试用） */
  vscanPort?: number | null
  /** Virtual IPP TLS（ipps）端口（null = 未启用；开发/测试用） */
  vippTlsPort?: number | null
}

export interface HostSettings {
  hostId: string
  hostName: string
  securityMode: 'open' | 'pairing'
  snmpCommunity?: string
  /** 控制台访问控制（P2 安全轮：管理面令牌，与设备配对轴独立）
   *  token 仅在启用态非空（需已通过鉴权才能读到；禁用态为 null） */
  consoleAuth?: { enabled: boolean; token: string | null }
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

export const OPS_VERSION = '0.4.0'

export const BACKEND_LABEL: Record<BackendKind, string> = {
  mock: 'Mock · 虚拟打印机',
  ipp: 'IPP · 直连',
  cups: 'CUPS · 系统',
  windows: 'Windows · 系统打印',
  android: 'Android Print',
  airprint: 'AirPrint',
}

export const CAPABILITY_STATE_LABEL: Record<CapabilityState, string> = {
  supported: 'SUPPORTED',
  unsupported: 'UNSUPPORTED',
  unknown: 'UNKNOWN',
}

export const CONSUMABLE_KIND_LABEL: Record<ConsumableInfo['kind'], string> = {
  toner: '碳粉',
  ink: '墨水',
  drum: '鼓组件',
  'maintenance-kit': '维护组件',
  other: '其他',
}

// ---------------------------------------------------------------- 扫描（P3 · eSCL）
export type ScanDeviceSource = 'vscan' | 'mdns' | 'manual'

export interface ScanDevice {
  id: string
  name: string
  host: string
  port: number
  baseUrl: string
  source: ScanDeviceSource
  txt?: Record<string, string>
  lastSeenAt: string
}

export type ScanJobState = 'pending' | 'scanning' | 'completed' | 'failed' | 'cancelled'

/** 扫描任务已导出 PDF 的元数据（与 Host 端 core/types 对齐） */
export interface ScanJobPdfExport {
  exportedAt: string
  pages: number
  bytes: number
  durationMs: number
}

export interface ScanJob {
  id: string
  deviceId: string
  deviceName: string
  state: ScanJobState
  format: 'image/png' | 'application/pdf'
  dpi: number
  colorMode: 'RGB' | 'Grayscale'
  inputSource: 'Platen' | 'Feeder'
  pagesDone: number
  pagesTotal: number
  images: string[]
  /** 按需 PDF 导出结果（null/undefined = 未导出） */
  pdf?: ScanJobPdfExport | null
  error: string | null
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
}

export const SCAN_JOB_STATE_LABEL: Record<ScanJobState, string> = {
  pending: '排队中',
  scanning: '扫描中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}
