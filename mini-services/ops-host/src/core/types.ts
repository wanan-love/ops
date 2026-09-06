/**
 * OpenPrintShare — Core Domain Types
 * 平台无关：此文件不允许 import 任何平台 API / 运行时依赖。
 * Web 控制台通过 tsconfig path alias (@ops-core/*) 复用此契约。
 */

export const OPS_VERSION = '0.3.0'
export const OPS_API_VERSION = 1

/** 客户端平台标识 */
export type Platform = 'windows' | 'macos' | 'linux' | 'android' | 'ios' | 'web'

/** 打印后端种类（可插拔：mock=虚拟打印机 / ipp=IPP 协议直连 / cups=系统 CUPS / windows=Win32 打印栈） */
export type BackendKind = 'mock' | 'windows' | 'cups' | 'ipp' | 'android' | 'airprint'

/** 能力三态：supported=确定支持 / unsupported=确定不支持 / unknown=读取不到（≠ 不支持） */
export type CapabilityState = 'supported' | 'unsupported' | 'unknown'

/** 能力四元组数据来源：value + state + source + timestamp 缺一不可 */
export type CapabilitySource =
  | 'SYSTEM'   // 由 OPS 自身定义（虚拟打印机能力是定义出来的，确定）
  | 'CUPS'     // CUPS 守护进程（lpstat / ipp://localhost:631）
  | 'IPP'      // IPP Get-Printer-Attributes 响应属性
  | 'WSD'      // WSD Scan/Print（预留）
  | 'SNMP'     // Printer-MIB（RFC 3805）
  | 'VENDOR_API' // 厂商私有 API（预留）
  | 'UNKNOWN'

/**
 * 能力四元组：value + state + source + timestamp。
 * state=unknown 时 value 必为 null（读取不到 ≠ 不支持，禁止精测）。
 * detail 记录来源细节（IPP 属性名 / 探测错误原因）。
 */
export interface Capability<T> {
  value: T | null
  state: CapabilityState
  source: CapabilitySource
  timestamp: string
  detail?: string
}

/** 耗材信息。levelPct=null 表示读取不到（UNKNOWN），UI 应回隐藏耗材模块而不是显示假 0% */
export interface ConsumableInfo {
  name: string
  kind: 'toner' | 'ink' | 'drum' | 'maintenance-kit' | 'other'
  color?: string
  levelPct: number | null
  source: CapabilitySource
}

/** 单个来源的能力探测记录（失败也保留，不影响其它能力与打印可用性） */
export interface CapabilityProbe {
  source: CapabilitySource
  ok: boolean
  durationMs: number
  error?: string
  at: string
}

/**
 * 能力报告：每个能力均为四元组；probes 记录全部来源探测（含失败）。
 * 任何协议探测失败（如 SNMP 超时）不影响其余能力，也不影响打印机可用。
 */
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
  /** 后端内的打印机标识（CUPS queue 名 / vipp printer id / 手动添加的 URI） */
  backendKey?: string
  /** 后端打印机 URI（如 ipp://localhost:3061/printers/vipp-full） */
  backendUri?: string
  /** 最近一次能力探测报告（三态模型，含各来源 probes） */
  capabilityReport?: CapabilityReport
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
  /** 提交到真实后端后的后端任务 id（IPP job-id 等，Host 重启后据此恢复轮询） */
  backendJobId?: string
  /** 后端任务 URI（IPP job-uri） */
  backendJobUri?: string
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

/** mDNS 发现的网络打印机（_ipp._tcp / _pdl-datastream 等） */
export interface DiscoveredIpPrinter {
  /** 服务实例名（PTR 目标的首标签，如 "OPS Virtual IPP Full"） */
  name: string
  /** SRV target 主机名 */
  host: string
  /** A 记录解析出的 IP */
  ip: string
  port: number
  /** 推导的 IPP URI（TXT rp 提供 resource path，缺省 ipp/print） */
  uri: string
  txt: Record<string, string>
  source: 'mdns'
}

/** Virtual IPP Server 打印机快照（vipp:update 事件 / REST 响应） */
export interface VippPrinterSnapshot {
  id: string
  name: string
  profile: string
  state: 'idle' | 'processing' | 'stopped'
  stateReasons: string[]
  queuedJobs: number
  activeJobId: number | null
  completedJobs: number
  ppm: number
  condition: string
  updatedAt: string
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
  /** 主后端（可用后端里优先 ipp/cups/windows，否则 mock）——保留旧字段以兼容现有前端 */
  backend: BackendKind
  /** 激活的后端列表（阶段 2 新增） */
  backends?: BackendKind[]
  uptimeSec: number
  securityMode: 'open' | 'pairing'
  restPort: number
  wsPort: number
  dataDir: string
}
