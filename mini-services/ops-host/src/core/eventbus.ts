import { EventEmitter } from 'node:events'
import type { DiscoveredHost, HostInfo, OpsEvent, PairedDevice, PairingRequest, Printer, PrintJob, TestRun } from './types'

/** 领域事件总线：Core 内部解耦 + WS 实时层广播的数据源 */
export interface BusEvents {
  'job:update': { job: PrintJob }
  'printer:update': { printer: Printer }
  'host:update': { info: HostInfo }
  'event': { event: OpsEvent }
  'pairing:update': { requests: PairingRequest[]; devices: PairedDevice[] }
  'test:progress': { run: TestRun }
  'discovery:update': { hosts: DiscoveredHost[] }
  /** 请求客户端重新拉取快照（Host 重启等） */
  'snapshot': Record<string, never>
}

export class EventBus {
  private emitter = new EventEmitter()

  on<K extends keyof BusEvents>(event: K, listener: (payload: BusEvents[K]) => void): () => void {
    this.emitter.on(event, listener)
    return () => {
      this.emitter.off(event, listener)
    }
  }

  emit<K extends keyof BusEvents>(event: K, payload: BusEvents[K]): void {
    this.emitter.emit(event, payload)
  }
}
