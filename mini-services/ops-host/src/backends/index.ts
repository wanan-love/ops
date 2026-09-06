import type { BackendKind, PrinterCapabilities } from '../core/types'

/**
 * PrinterBackend — 打印后端统一接口（可插拔）。
 *
 * MVP 使用 MockPrinterBackend（Virtual Printer，无需任何物理设备）。
 * 阶段 10 接入真实打印机时新增：
 *  - WindowsPrinterBackend：Win32 Print Spooler（Get-Printer / Add-Job / RAW 或 XPS pass-through）
 *  - CupsPrinterBackend：CUPS via IPP（ipp://host:631/printers/xxx，print-job 操作）
 * Core / 协议 / 队列 / UI 均不感知后端差异。
 */
export interface SystemPrinterDescriptor {
  /** 系统内的打印机名（Win32 打印机名 / CUPS queue 名） */
  systemName: string
  displayName: string
  description: string
  location: string
  capabilities: Partial<PrinterCapabilities>
}

export interface PrinterBackend {
  kind: BackendKind
  /** 当前运行环境是否可用（如 Windows 后端在 Linux 上不可用） */
  available(): Promise<boolean>
  /** 不可用时的解释（显示在 Host 控制台） */
  readonly availabilityNote: string
  /** 枚举系统打印机（真实后端 → 导入为 OPS Printer） */
  listSystemPrinters(): Promise<SystemPrinterDescriptor[]>
}

/** MockPrinterBackend：Virtual Printer，始终可用 */
export class MockPrinterBackend implements PrinterBackend {
  readonly kind = 'mock' as const
  readonly availabilityNote = 'Virtual Printer 模拟后端（MVP）：接收 PDF 并模拟完整打印流程，无需物理设备'

  async available(): Promise<boolean> {
    return true
  }

  async listSystemPrinters(): Promise<SystemPrinterDescriptor[]> {
    // 虚拟打印机由 PrinterRegistry 直接管理（种子/用户创建/Self-Test 创建）
    return []
  }
}

/** Windows 真实后端（阶段 10） */
export class WindowsPrinterBackend implements PrinterBackend {
  readonly kind = 'windows' as const
  readonly availabilityNote = 'Windows Print Spooler 后端（阶段 10）：需在 Windows 宿主上运行，通过 PowerShell Get-Printer / Add-Job 提交'

  async available(): Promise<boolean> {
    return process.platform === 'win32'
  }

  async listSystemPrinters(): Promise<SystemPrinterDescriptor[]> {
    throw new Error('WindowsPrinterBackend 尚未实现（阶段 10）——当前环境使用 MockPrinterBackend')
  }
}

/** CUPS 真实后端（阶段 10，macOS / Linux） */
export class CupsPrinterBackend implements PrinterBackend {
  readonly kind = 'cups' as const
  readonly availabilityNote = 'CUPS/IPP 后端（阶段 10）：需在 macOS/Linux 宿主上运行，通过 ipp:// 631 端口 print-job 提交'

  async available(): Promise<boolean> {
    return process.platform === 'darwin' || process.platform === 'linux'
  }

  async listSystemPrinters(): Promise<SystemPrinterDescriptor[]> {
    throw new Error('CupsPrinterBackend 尚未实现（阶段 10）——当前环境使用 MockPrinterBackend')
  }
}

/** Android Print Framework 后端（阶段 10，Android Host） */
export class AndroidPrinterBackend implements PrinterBackend {
  readonly kind = 'android' as const
  readonly availabilityNote = 'Android Print Framework 后端（阶段 8+）：Android Host App 内实现 PrintService 桥接'

  async available(): Promise<boolean> {
    return false
  }

  async listSystemPrinters(): Promise<SystemPrinterDescriptor[]> {
    throw new Error('AndroidPrinterBackend 尚未实现')
  }
}

/** iOS AirPrint 透传后端（阶段 10，iOS Host） */
export class AirPrintPrinterBackend implements PrinterBackend {
  readonly kind = 'airprint' as const
  readonly availabilityNote = 'AirPrint/IPP 透传后端（阶段 9+）：iOS 通过 UIPrintInteractionController / IPP Everywhere'

  async available(): Promise<boolean> {
    return false
  }

  async listSystemPrinters(): Promise<SystemPrinterDescriptor[]> {
    throw new Error('AirPrintPrinterBackend 尚未实现')
  }
}

export const mockBackend = new MockPrinterBackend()
export const windowsBackend = new WindowsPrinterBackend()
export const cupsBackend = new CupsPrinterBackend()

export function allBackends(): PrinterBackend[] {
  return [mockBackend, windowsBackend, cupsBackend, new AndroidPrinterBackend(), new AirPrintPrinterBackend()]
}
