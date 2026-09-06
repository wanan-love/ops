import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { createOpsHost } from './src/host'
import { createRestServer } from './src/http/server'
import { attachRealtime } from './src/ws/realtime'
import { OPS_VERSION } from './src/core/types'
import { detectRuntimePlatform, platformLabel, runtimePlatformDetail } from './src/core/runtime'

/**
 * OpenPrintShare Host 守护进程（独立 Bun 服务；打包产物为单文件可执行）
 *
 *  REST     : 3001   （OPS/1.0 协议，网关 ?XTransformPort=3001）
 *  Realtime : 3002   （socket.io，path '/'，网关 ?XTransformPort=3002）
 *  Web 控制台 : 打包模式随包分发（--web <dir> 或内嵌资产），由 REST 端口直接服务
 *  数据目录 : ./data/mock-printer（--data-dir / OPS_DATA_DIR 可覆盖；打包产物由启动器设置）
 *
 * ⚠️ 运行模式（虚拟设备与正式产品隔离红线）：
 *  正式模式（默认）：不注册 Mock 后端、不种虚拟打印机、不启动 vipp/vscan/vpjl；
 *                    系统真实打印机（Windows 打印栈 / CUPS）自动发现并导入。
 *  开发/测试模式：--dev 或 OPS_DEV_MODE=1（虚拟打印机 + Virtual IPP/Scanner/PJL 仿真启用）。
 *
 * CLI（打包产物主要入口）：
 *   ops-host [--port 3001] [--ws-port 3002] [--data-dir <dir>] [--web <dir>] [--dev] [--version]
 * 环境变量等价：OPS_PORT / OPS_WS_PORT / OPS_DATA_DIR / OPS_WEB_DIR / OPS_DEV_MODE
 */

const version = (): string => OPS_VERSION

interface CliArgs {
  port: number
  wsPort: number
  dataDir: string
  webDir: string | null
  noVipp: boolean
  devMode: boolean
}

function parseCli(): CliArgs {
  const argv = process.argv.slice(2)
  const readValue = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    if (i >= 0 && i + 1 < argv.length) return argv[i + 1]
    const inline = argv.find((a) => a.startsWith(`${flag}=`))
    return inline ? inline.slice(flag.length + 1) : undefined
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`OpenPrintShare Host v${version()}
`)
    process.exit(0)
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`OpenPrintShare Host v${version()} — 跨平台局域网共享打印机

用法：ops-host [选项]

选项：
  --port <n>        REST/Web 端口（默认 3001，OPS_PORT）
  --ws-port <n>     WebSocket 端口（默认 REST+1，OPS_WS_PORT）
  --data-dir <dir>  数据目录（默认 ./data/mock-printer，OPS_DATA_DIR）
  --web <dir>       Web 控制台静态目录（打包模式，OPS_WEB_DIR）
  --dev             开发/测试模式（启用虚拟打印机与仿真设备；等价 OPS_DEV_MODE=1）
  --version         版本号
  --help            本帮助
`)
    process.exit(0)
  }
  const port = Number(readValue('--port') ?? process.env.OPS_PORT ?? 3001) || 3001
  const wsPort = Number(readValue('--ws-port') ?? process.env.OPS_WS_PORT ?? port + 1) || port + 1
  const dataDir = resolve(readValue('--data-dir') ?? process.env.OPS_DATA_DIR ?? './data/mock-printer')
  const webDirRaw = readValue('--web') ?? process.env.OPS_WEB_DIR ?? null
  const webDir = webDirRaw && existsSync(resolve(webDirRaw)) ? resolve(webDirRaw) : null
  const noVipp = argv.includes('--no-vipp') || process.env.OPS_VIPP_ENABLED === '0'
  if (noVipp) process.env.OPS_VIPP_ENABLED = '0'
  // 开发/测试模式：--dev 显式开启（或 OPS_DEV_MODE=1）；正式产物默认正式模式
  const devMode = argv.includes('--dev') || process.env.OPS_DEV_MODE === '1'
  if (devMode) process.env.OPS_DEV_MODE = '1'
  return { port, wsPort, dataDir, webDir, noVipp, devMode }
}

function printBanner(args: CliArgs): void {
  const line = (s: string): void => process.stdout.write(`${s}\n`)
  const runtime = runtimePlatformDetail()
  line('')
  line('  ┌─────────────────────────────────────────────────────┐')
  line('  │            OpenPrintShare Host                      │')
  line(`  │            跨平台局域网共享打印机 v${OPS_VERSION}            │`)
  line('  └─────────────────────────────────────────────────────┘')
  line('')
  if (args.webDir) {
    line(`  ▸ Web 控制台:  http://localhost:${args.port}/`)
  }
  line(`  ▸ REST API :   http://localhost:${args.port}/  (OPS/1.0)`)
  line(`  ▸ Realtime :   http://localhost:${args.wsPort}/  (WebSocket)`)
  // 平台信息由运行时多信号动态检测（绝不使用开发/编译环境固定值）
  line(`  ▸ 运行平台 :   ${platformLabel(detectRuntimePlatform())}${runtime.version ? `（${runtime.version}）` : ''}${runtime.release ? ` release=${runtime.release}` : ''} — 运行时检测`)
  line(
    args.devMode
      ? '  ▸ 运行模式 :   开发/测试（--dev / OPS_DEV_MODE=1：虚拟打印机 + vipp/vscan/vpjl 仿真启用）'
      : '  ▸ 运行模式 :   正式（系统真实打印机自动发现；无任何虚拟设备）',
  )
  line(`  ▸ 数据目录 :   ${args.dataDir}`)
  line('')
}

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
  const args = parseCli()
  printBanner(args)

  const host = await createOpsHost({ restPort: args.port, wsPort: args.wsPort, dataDir: args.dataDir, webDir: args.webDir })
  const rest = createRestServer(host.ctx, args.port)
  const realtime = attachRealtime(host.ctx, args.wsPort)
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
    console.log('[ops-host] started — 运行时已随二进制打包，无需安装 Node/Python/Rust')
  })
  .catch((err) => {
    console.error('[ops-host] fatal:', err)
    process.exit(1)
  })

process.on('unhandledRejection', (reason) => {
  console.error('[ops-host] unhandled rejection:', reason)
})
