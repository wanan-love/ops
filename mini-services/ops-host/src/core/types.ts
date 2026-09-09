/**
 * OpenPrintShare — Core Domain Types
 * 平台无关：此文件不允许 import 任何平台 API / 运行时依赖。
 * Web 控制台通过 tsconfig path alias (@ops-core/*) 复用此契约。
 */

export const OPS_VERSION = '0.4.9'
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
 * 合法形态「supported + value=null」= 确认支持但具体值不可获取（如 WMI 只报告「支持双面」
 * 但不区分长边/短边翻转模式）——此时 detail 必须写明不可获取的原因，UI 显示 SUPPORTED + 值 UNKNOWN。
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
  /** 成功时的补充信息（如 PJL 回读的原始 CODE；可选，仅诊断展示用） */
  detail?: string
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
  /** 纸盒/托盘列表（P5：Windows DeviceCapabilities DC_BINNAMES；其它来源读不到时为 unknown） */
  paperTrays: Capability<string[]>
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
  /** 纸盒/托盘列表（可选：真实后端 DC_BINNAMES 探测到才赋值；未知 ≠ 空列表） */
  paperTrays?: string[]
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
  /** 系统默认打印机标记（Windows Win32_Printer.Default / CUPS lpstat -d；后端枚举时刷新，无法获取时缺省） */
  isSystemDefault?: boolean
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
  /** SNMP v1/v2c community 字符串（耗材/状态探测用；企业机型常改为非默认值） */
  snmpCommunity?: string
  /** PJL over RAW 9100 双向状态/耗材探测（P4 Vendor Adapter 试点）。
   *  默认关闭（VENDOR_PROTOCOLS.md 安全默认：9100 通道显式启用）；
   *  仅在 IPP/SNMP 未读到时补充（merge 来源优先级 VENDOR_API < SNMP < IPP）。 */
  pjlProbeEnabled?: boolean
  /** PJL 探测目标端口（真实设备通用 9100；测试环境可指向 Virtual PJL :3067） */
  pjlPort?: number
  /** HP LEDM/CDM 双向探测（P9 Vendor Adapter；HPLIP 实证通道 LEDM HTTP 8080 XML + CDM HTTP 80 JSON）。
 *  默认关闭（VENDOR_PROTOCOLS.md 安全默认）；仅在 IPP/SNMP/PJL 未读到时补充（merge 来源优先级 VENDOR_API 最低）。 */
  hpLedmProbeEnabled?: boolean
  /** LEDM 探测目标端口（真实 HP 8080——HPLIP hpmud/jd.c:507；测试指向 Virtual LEDM :3068） */
  hpLedmPort?: number
  /** CDM 探测目标端口（真实 HP 80；测试与 LEDM 同指 :3068） */
  hpCdmPort?: number
  /** 控制台访问控制（P2 安全轮：REST/WS 管理面令牌；与设备配对轴相互独立）
   *  - enabled=false 时 token 恒为 null（启用时总是生成全新令牌，避免禁用期间的旧值泄露）
   *  - token 仅在启用期间存在（settings.json 持久化，Host 重启后仍有效）
   */
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
  /** 控制台访问控制是否启用（公开信息：客户端需据此展示解锁界面，不含令牌本身） */
  consoleAuthEnabled?: boolean
  restPort: number
  wsPort: number
  dataDir: string
  /** 开发/测试模式（OPS_DEV_MODE=1）：虚拟打印机与 vipp/vscan/vpjl 仅在此模式启用；正式运行恒为 false */
  devMode?: boolean
  /** 运行时平台检测明细（信号链 + os 运行时版本；真实性红线：动态检测，非编译期固定值） */
  platformRuntime?: {
    platform: 'windows' | 'macos' | 'linux'
    signals: string[]
    release: string
    version: string
    type: string
  }
  /** Virtual IPP TLS（ipps）端口（null = 未启用；开发/测试用） */
  vippTlsPort?: number | null
  /** Virtual eSCL Scanner 端口（null = 未启用；开发/测试用） */
  vscanPort?: number | null
  /** Virtual PJL Printer（RAW 9100 仿真）端口（null = 未启用；开发/测试用） */
  vpjlPort?: number | null
  /** Virtual HP LEDM/CDM Printer（HTTP 仿真，P9 Vendor Adapter）端口（null = 未启用；开发/测试用） */
  vledmPort?: number | null
}

// ---------------------------------------------------------------- 扫描（P3 · eSCL）

/** 扫描设备 */
export interface ScanDevice {
  id: string
  name: string
  host: string
  port: number
  baseUrl: string
  source: 'vscan' | 'mdns' | 'manual'
  txt?: Record<string, string>
  /** 双面扫描能力三态（vscan 静态已知 / manual 添加时探测 / mdns 未探测） */
  duplexCap?: 'yes' | 'no' | 'unknown'
  lastSeenAt: string
}

export type ScanJobState = 'pending' | 'scanning' | 'completed' | 'failed' | 'cancelled'

/** 扫描任务已导出 PDF 的元数据（按需合成：document.pdf 落盘后记录，重复导出幂等复用） */
export interface ScanJobPdfExport {
  exportedAt: string
  /** PDF 页数（= 导出时已完成的图像页数） */
  pages: number
  /** 文件字节数（展示用） */
  bytes: number
  /** 导出耗时（ms） */
  durationMs: number
}

/** 扫描任务 */
export interface ScanJob {
  id: string
  deviceId: string
  deviceName: string
  state: ScanJobState
  format: 'image/png' | 'application/pdf'
  dpi: number
  colorMode: 'RGB' | 'Grayscale'
  inputSource: 'Platen' | 'Feeder'
  /** 双面扫描（仅 Feeder 有效；vscan 模拟 2 张纸 → 4 页正反交替） */
  duplex?: boolean
  pagesDone: number
  pagesTotal: number
  images: string[]
  /** 每页正反面标识（与 images 索引对齐；非双面任务为 undefined） */
  pageSides?: Array<'front' | 'back'>
  /** 按需 PDF 导出结果（null/undefined = 未导出；仅 completed 任务可导出） */
  pdf?: ScanJobPdfExport | null
  error: string | null
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
}
