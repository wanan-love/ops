'use client'

import type {
  BackendKind,
  DiscoveredHost,
  HostInfo,
  HostSettings,
  OpsEvent,
  PairingRequest,
  PairedDevice,
  Printer,
  PrintJob,
  PrintOptions,
  PrintResult,
  ScenarioResult,
  ScanDevice,
  ScanJob,
  SystemStats,
  TestRun,
} from './types'
import { getConsoleToken, getPairedToken, loadDevice } from './device'

/** 控制台鉴权 401 事件（request 层 → 全局解锁界面）：与设备配对 401 区分的专属标记 */
export const CONSOLE_AUTH_REQUIRED_EVENT = 'ops:console-auth-required'

function notifyConsoleAuthRequired(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(CONSOLE_AUTH_REQUIRED_EVENT))
}

/** 协议约定：REST {port} + Realtime {port+1}
 *  - 网关模式（默认/沙箱）：相对路径 + ?XTransformPort（Caddy 转发）
 *  - 直连模式（打包产物，NEXT_PUBLIC_OPS_DIRECT=1 构建时注入）：REST 同源相对路径，
 *    WS 绝对地址（页面由 Host 本体服务时，WS 独立端口直连）
 */
export const OPS_DIRECT_MODE = process.env.NEXT_PUBLIC_OPS_DIRECT === '1'

/** 控制台令牌注入 query（<img>/下载链接无法带 header，全部 URL 追加 opsToken=；未启用时后端忽略） */
function withOpsToken(url: string): string {
  const token = getConsoleToken()
  if (!token) return url
  return url + (url.includes('?') ? '&' : '?') + 'opsToken=' + encodeURIComponent(token)
}

export function restUrl(port: number, path: string): string {
  return withOpsToken(`/api${path}${path.includes('?') ? '&' : '?'}XTransformPort=${port}`)
}

export function wsUrl(rtPort: number): string {
  if (OPS_DIRECT_MODE && typeof window !== 'undefined') {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    return `${proto}://${window.location.hostname}:${rtPort}`
  }
  return `/?XTransformPort=${rtPort}`
}

/** 扫描结果图像 URL（PNG 页）
 *  - 网关模式：相对 /api + XTransformPort（与 restUrl 一致）
 *  - 直连模式：REST 独立端口绝对地址
 *  两种模式均追加 opsToken=（<img> 标签无法携带鉴权 header）
 */
export function scanImageUrl(port: number, jobId: string, page: number): string {
  const path = `/scan/jobs/${encodeURIComponent(jobId)}/image?page=${page}`
  if (OPS_DIRECT_MODE && typeof window !== 'undefined') {
    const proto = window.location.protocol === 'https:' ? 'https' : 'http'
    return withOpsToken(`${proto}://${window.location.hostname}:${port}/api${path}`)
  }
  return restUrl(port, path)
}

/** 扫描导出 PDF 下载 URL（与 scanImageUrl 同模式：网关/直连） */
export function scanPdfUrl(port: number, jobId: string): string {
  const path = `/scan/jobs/${encodeURIComponent(jobId)}/pdf`
  if (OPS_DIRECT_MODE && typeof window !== 'undefined') {
    const proto = window.location.protocol === 'https:' ? 'https' : 'http'
    return withOpsToken(`${proto}://${window.location.hostname}:${port}/api${path}`)
  }
  return restUrl(port, path)
}

export class ApiError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message)
  }
}

async function request<T>(port: number, method: string, path: string, opts?: { json?: unknown; raw?: ArrayBuffer; rawText?: string }): Promise<T> {
  const headers: Record<string, string> = {}
  if (opts?.json !== undefined) headers['content-type'] = 'application/json'
  const consoleToken = getConsoleToken()
  if (consoleToken) headers['x-ops-console-token'] = consoleToken
  const res = await fetch(restUrl(port, path), {
    method,
    headers,
    body: opts?.json !== undefined ? JSON.stringify(opts.json) : opts?.rawText,
    cache: 'no-store',
  })
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  if (!res.ok) {
    // 控制台鉴权缺失/失效 → 全局解锁界面（设备配对 401 不带此 code，不弹锁）
    if (res.status === 401 && (data as { code?: string } | null)?.code === 'console_auth_required') {
      notifyConsoleAuthRequired()
    }
    const message = (data as { error?: string } | null)?.error ?? `请求失败（HTTP ${res.status}）`
    throw new ApiError(res.status, message)
  }
  return data as T
}

function encodeHeaders(extra: Record<string, string>): Record<string, string> {
  const device = loadDevice()
  const token = getPairedToken()
  const consoleToken = getConsoleToken()
  return {
    'content-type': 'application/pdf',
    'x-ops-device': encodeURIComponent(device.deviceId),
    'x-ops-device-name': encodeURIComponent(device.deviceName),
    'x-ops-platform': 'web',
    ...(token ? { 'x-ops-token': token } : {}),
    ...(consoleToken ? { 'x-ops-console-token': consoleToken } : {}),
    ...extra,
  }
}

export interface SubmitJobInput {
  file: File | Blob
  fileName: string
  printerId: string
  options: PrintOptions
}

/** OPS 协议客户端（全部走网关相对路径） */
export function createOpsClient(port: number) {
  return {
    // system
    systemInfo: () => request<HostInfo>(port, 'GET', '/system/info'),
    systemStats: () => request<SystemStats>(port, 'GET', '/system/stats'),

    // discovery
    discoveryHosts: () => request<{ hosts: DiscoveredHost[] }>(port, 'GET', '/discovery/hosts'),
    announce: () => request<{ host: DiscoveredHost }>(port, 'GET', '/discovery/announce'),

    // printers
    printers: (scope: 'client' | 'admin' = 'client') => request<{ printers: Printer[] }>(port, 'GET', `/printers?scope=${scope}`),
    printer: (id: string) => request<{ printer: Printer }>(port, 'GET', `/printers/${encodeURIComponent(id)}`),
    createPrinter: (input: { name: string; description?: string; location?: string; shared?: boolean; capabilities?: Partial<Printer['capabilities']> }) =>
      request<{ printer: Printer }>(port, 'POST', '/printers', { json: input }),
    updatePrinter: (id: string, patch: { name?: string; description?: string; location?: string; shared?: boolean }) =>
      request<{ printer: Printer }>(port, 'PATCH', `/printers/${encodeURIComponent(id)}`, { json: patch }),
    deletePrinter: (id: string) => request<{ ok: boolean }>(port, 'DELETE', `/printers/${encodeURIComponent(id)}`),
    testPrint: (id: string) => request<{ job: PrintJob }>(port, 'POST', `/printers/${encodeURIComponent(id)}/test-print`),

    // jobs
    jobs: (filter?: { printerId?: string; state?: string; deviceId?: string; limit?: number }) => {
      const params = new URLSearchParams()
      if (filter?.printerId) params.set('printerId', filter.printerId)
      if (filter?.state) params.set('state', filter.state)
      if (filter?.deviceId) params.set('deviceId', filter.deviceId)
      if (filter?.limit) params.set('limit', String(filter.limit))
      const qs = params.toString()
      return request<{ jobs: PrintJob[] }>(port, 'GET', `/jobs${qs ? `?${qs}` : ''}`)
    },
    job: (id: string) => request<{ job: PrintJob }>(port, 'GET', `/jobs/${encodeURIComponent(id)}`),
    jobResult: (id: string) => request<{ result: PrintResult }>(port, 'GET', `/jobs/${encodeURIComponent(id)}/result`),
    submitJob: async (input: SubmitJobInput): Promise<PrintJob> => {
      const headers = encodeHeaders({ 'x-ops-options': encodeURIComponent(JSON.stringify(input.options)) })
      const res = await fetch(restUrl(port, `/jobs?printerId=${encodeURIComponent(input.printerId)}&fileName=${encodeURIComponent(input.fileName)}`), {
        method: 'POST',
        headers,
        body: input.file,
      })
      const data = (await res.json()) as { job?: PrintJob; error?: string }
      if (!res.ok || !data.job) throw new ApiError(res.status, data.error ?? '提交失败')
      return data.job
    },
    cancelJob: (id: string) => request<{ ok: boolean; message: string }>(port, 'POST', `/jobs/${encodeURIComponent(id)}/cancel`),
    retryJob: (id: string) => request<{ ok: boolean; message: string }>(port, 'POST', `/jobs/${encodeURIComponent(id)}/retry`),
    jobDocumentUrl: (id: string) => restUrl(port, `/jobs/${encodeURIComponent(id)}/document`),

    // events
    events: (limit = 200, type?: string) =>
      request<{ events: OpsEvent[] }>(port, 'GET', `/events?limit=${limit}${type ? `&type=${type}` : ''}`),

    // pairing & settings
    pairingRequests: () => request<{ requests: PairingRequest[] }>(port, 'GET', '/pairing/requests'),
    requestPairing: (device: { deviceId: string; deviceName: string; platform: string }) =>
      request<{ request: PairingRequest }>(port, 'POST', '/pairing/requests', { json: device }),
    approvePairing: (id: string) => request<{ token: string }>(port, 'POST', `/pairing/requests/${encodeURIComponent(id)}/approve`),
    rejectPairing: (id: string) => request<{ ok: boolean }>(port, 'POST', `/pairing/requests/${encodeURIComponent(id)}/reject`),
    pairingStatus: (deviceId: string) => request<{ pending: PairingRequest[]; token: string | null; paired: boolean }>(port, 'GET', `/pairing/status?deviceId=${encodeURIComponent(deviceId)}`),
    devices: () => request<{ devices: PairedDevice[] }>(port, 'GET', '/devices'),
    revokeDevice: (deviceId: string) => request<{ ok: boolean }>(port, 'DELETE', `/devices/${encodeURIComponent(deviceId)}`),
    settings: () => request<{ settings: HostSettings }>(port, 'GET', '/settings'),
    updateSettings: (patch: { hostName?: string; securityMode?: 'open' | 'pairing'; snmpCommunity?: string; pjlProbeEnabled?: boolean; pjlPort?: number }) =>
      request<{ settings: HostSettings }>(port, 'PATCH', '/settings', { json: patch }),

    // console auth（P2 安全轮：管理面令牌）
    consoleAuth: (token: string) => request<{ ok: boolean; info: HostInfo }>(port, 'POST', '/console/auth', { json: { token } }),
    consoleEnable: () => request<{ ok: boolean; token: string; settings: HostSettings }>(port, 'POST', '/console/enable', { json: {} }),
    consoleDisable: () => request<{ ok: boolean; settings: HostSettings }>(port, 'POST', '/console/disable', { json: {} }),
    consoleRegenerateToken: () => request<{ ok: boolean; token: string }>(port, 'POST', '/console/token/regenerate', { json: {} }),

    // mock / debug 控制台
    setCondition: (id: string, condition: 'online' | 'offline' | 'paper-out' | 'paper-jam' | 'error', message?: string) =>
      request<{ printer: Printer }>(port, 'POST', `/mock/printers/${encodeURIComponent(id)}/condition`, { json: { condition, message } }),
    fixPrinter: (id: string, action: 'add-paper' | 'clear-jam') =>
      request<{ message: string }>(port, 'POST', `/mock/printers/${encodeURIComponent(id)}/fix`, { json: { action } }),
    resumePrinter: (id: string) => request<{ message: string }>(port, 'POST', `/mock/printers/${encodeURIComponent(id)}/resume`),
    setSpeed: (id: string, ppm: number) => request<{ printer: Printer }>(port, 'POST', `/mock/printers/${encodeURIComponent(id)}/speed`, { json: { ppm } }),
    refillInk: (id: string) => request<{ printer: Printer }>(port, 'POST', `/mock/printers/${encodeURIComponent(id)}/ink`),
    resetPrinter: (id: string) => request<{ printer: Printer }>(port, 'POST', `/mock/printers/${encodeURIComponent(id)}/reset`),
    failJob: (id: string, message?: string) => request<{ message: string }>(port, 'POST', `/mock/jobs/${encodeURIComponent(id)}/fail`, { json: { message } }),
    debugRestart: () => request<{ message: string }>(port, 'POST', '/debug/restart'),
    clearTestData: () => request<{ printers: number; jobs: number; testRuns: number }>(port, 'POST', '/storage/clear-test-data'),
    samplePdfUrl: (pages = 2) => restUrl(port, `/debug/sample-pdf?pages=${pages}`),

    // self-test
    testScenarios: () => request<{ scenarios: Array<{ id: string; name: string; description: string }> }>(port, 'GET', '/tests/scenarios'),
    runTests: (ids?: string[]) => request<{ runId: string }>(port, 'POST', '/tests/run', { json: ids ? { ids } : {} }),
    testRuns: () => request<{ runs: TestRun[] }>(port, 'GET', '/tests/runs'),

    // 打印后端（第二阶段：Mock / IPP / CUPS / Windows 统一接口）
    backends: () => request<{ backends: BackendStatus[] }>(port, 'GET', '/backends'),
    backendPrinters: (kind: string) => request<{ printers: BackendPrinterRef[] }>(port, 'GET', `/backends/${encodeURIComponent(kind)}/printers`),
    importPrinter: (input: { backend: string; key: string; shared?: boolean; displayName?: string }) =>
      request<{ printer: Printer }>(port, 'POST', '/printers/import', { json: input }),
    addPrinterUri: (input: { uri: string; shared?: boolean; displayName?: string }) =>
      request<{ printer: Printer }>(port, 'POST', '/printers/add-uri', { json: input }),
    refreshCapabilities: (id: string) =>
      request<{ printer: Printer }>(port, 'POST', `/printers/${encodeURIComponent(id)}/refresh-capabilities`),

    // Virtual IPP Server
    vippPrinters: () => request<VippInfo>(port, 'GET', '/vipp/printers'),
    setVippCondition: (id: string, condition: string, message?: string) =>
      request<{ ok: boolean; message?: string }>(port, 'POST', `/vipp/printers/${encodeURIComponent(id)}/condition`, { json: { condition, message } }),

    // Virtual PJL Printer（P4 · RAW 9100 仿真）
    vpjlState: () => request<{ state: VpjlState }>(port, 'GET', '/vpjl/state'),
    setVpjlCondition: (condition: string) =>
      request<{ ok: boolean; state: VpjlState; message?: string }>(port, 'POST', '/vpjl/condition', { json: { condition } }),

    // mDNS 网络打印机发现
    mdnsScan: () => request<{ printers: DiscoveredIpPrinter[] }>(port, 'POST', '/discovery/mdns/scan'),

    // scan（P3 · eSCL）
    scanDevices: () => request<{ devices: ScanDevice[] }>(port, 'GET', '/scan/devices'),
    scanMdns: () => request<{ devices: ScanDevice[] }>(port, 'POST', '/scan/devices/scan-mdns'),
    addScanDevice: (input: { baseUrl: string; name?: string }) =>
      request<{ device: ScanDevice }>(port, 'POST', '/scan/devices', { json: input }),
    removeScanDevice: (id: string) => request<{ ok: boolean }>(port, 'DELETE', `/scan/devices/${encodeURIComponent(id)}`),
    startScan: (input: { deviceId: string; format?: string; dpi?: number; colorMode?: string; inputSource?: string; duplex?: boolean }) =>
      request<{ job: ScanJob }>(port, 'POST', '/scan/jobs', { json: input }),
    scanJobs: () => request<{ jobs: ScanJob[] }>(port, 'GET', '/scan/jobs'),
    cancelScanJob: (id: string) => request<{ job: ScanJob }>(port, 'POST', `/scan/jobs/${encodeURIComponent(id)}/cancel`),
    deleteScanJob: (id: string) => request<{ ok: boolean }>(port, 'DELETE', `/scan/jobs/${encodeURIComponent(id)}`),
    scanImageUrl: (jobId: string, page: number) => scanImageUrl(port, jobId, page),
    // PDF 导出（P3.5：completed 任务多页 PNG → A4 合成，幂等缓存）
    exportScanPdf: (id: string) => request<{ job: ScanJob }>(port, 'POST', `/scan/jobs/${encodeURIComponent(id)}/export-pdf`),
    scanPdfUrl: (jobId: string) => scanPdfUrl(port, jobId),
  }
}

export type OpsClient = ReturnType<typeof createOpsClient>
export type { ScenarioResult }

/** 后端可用性状态（GET /api/backends） */
export interface BackendStatus {
  kind: BackendKind
  available: boolean
  note: string
}

/** 后端内打印机引用（listPrinters 结果） */
export interface BackendPrinterRef {
  key: string
  displayName: string
  description?: string
  location?: string
  uri?: string
  makeAndModel?: string
}

/** Virtual IPP Server 信息 */
export interface VippPrinterInfo {
  id: string
  name: string
  profile: string
  state: 'idle' | 'processing' | 'stopped'
  stateReasons: string[]
  queuedJobs: number
  activeJobId: string | null
  completedJobs: number
  ppm: number
  condition: string
  updatedAt: string
}

export interface VippInfo {
  port: number
  /** Virtual IPP TLS（ipps）端口（null = 未启用） */
  tlsPort: number | null
  dataDir: string
  printers: VippPrinterInfo[]
}

/** Virtual PJL Printer（RAW 9100 仿真）状态快照 */
export interface VpjlState {
  condition: string
  /** 累计接收的 RAW 打印字节数（UEL 之间的非 PJL 数据） */
  rawReceivedBytes: number
  /** 模拟已打印页数（每 5120 bytes 计 1 页） */
  rawPageCount: number
  /** 服务的连接总数（含已关闭） */
  connectionCount: number
  updatedAt: string
}

/** mDNS 发现的网络 IPP 打印机 */
export interface DiscoveredIpPrinter {
  name: string
  host: string
  ip: string
  port: number
  uri: string
  txt: Record<string, string>
  source: string
}
