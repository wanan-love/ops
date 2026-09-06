import { resolve } from 'node:path'
import { createOpsHost } from './src/host'
import { createRestServer } from './src/http/server'
import { attachRealtime } from './src/ws/realtime'

/**
 * OpenPrintShare Host 守护进程（独立 Bun mini-service）
 *
 *  REST     : 3001   （OPS/1.0 协议，网关 ?XTransformPort=3001）
 *  Realtime : 3002   （socket.io，path '/'，网关 ?XTransformPort=3002）
 *  Virtual IPP Server : 3061 （阶段 2：自建 IPP 服务端，真实 RFC 8010 二进制链路；OPS_VIPP_ENABLED=0 可关）
 *  数据目录 : ./data/mock-printer（可用 OPS_DATA_DIR 覆盖；vipp 任务在 ./data/virtual-ipp）
 *
 * bun --hot 热重载时通过 globalThis 守卫释放旧实例。
 */

const REST_PORT = 3001
const WS_PORT = 3002
const DATA_DIR = resolve(process.env.OPS_DATA_DIR ?? './data/mock-printer')

interface RunningInstance {
  dispose(): void
}

const g = globalThis as typeof globalThis & { __OPS_HOST_INSTANCE__?: RunningInstance }
if (g.__OPS_HOST_INSTANCE__) {
  try {
    g.__OPS_HOST_INSTANCE__.dispose()
  } catch (err) {
    console.warn('[ops-host] hot-reload dispose error:', err)
  }
}

async function main(): Promise<RunningInstance> {
  const host = await createOpsHost({ restPort: REST_PORT, wsPort: WS_PORT, dataDir: DATA_DIR })
  const rest = createRestServer(host.ctx, REST_PORT)
  const realtime = attachRealtime(host.ctx, WS_PORT)
  await host.start()

  const dispose = (): void => {
    host.dispose()
    rest.close()
    realtime.close()
  }

  process.on('SIGTERM', () => {
    dispose()
    process.exit(0)
  })
  process.on('SIGINT', () => {
    dispose()
    process.exit(0)
  })

  return { dispose }
}

main()
  .then((instance) => {
    g.__OPS_HOST_INSTANCE__ = instance
    console.log('[ops-host] started — backends: mock(Virtual Printer) + ipp(Virtual IPP Server :3061) + cups/windows(代码完备，本环境不可用)')
  })
  .catch((err) => {
    console.error('[ops-host] fatal:', err)
    process.exit(1)
  })

process.on('unhandledRejection', (reason) => {
  console.error('[ops-host] unhandled rejection:', reason)
})
