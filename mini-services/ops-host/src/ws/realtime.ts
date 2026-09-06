import { createServer, type Server as HttpServer } from 'node:http'
import { Server as IOServer, type Socket } from 'socket.io'
import type { HostContext } from '../host'

/**
 * 实时层：socket.io（path 必须为 '/'，网关按 ?XTransformPort={wsPort} 转发）。
 * 由于 engine.io 在 path '/' 下接管整个端口，实时服务独立监听 wsPort（REST 在 restPort）。
 *
 * 控制台鉴权（P2 安全轮）：
 *  - 握手阶段校验令牌（auth.token 或 query.opsToken），无效 → emit 'auth:error' + 断开
 *  - 令牌启用/重生成时主动断开全部存量连接（合法客户端会自动带新令牌重连）
 */
export function attachRealtime(ctx: HostContext, wsPort: number): { io: IOServer; server: HttpServer; close(): void } {
  const server = createServer((_req, res) => {
    // engine.io(path:'/') 会接管全部请求，此处仅作兜底
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ service: 'openprintshare-realtime', note: 'use socket.io at path /' }))
  })

  const io = new IOServer(server, {
    // DO NOT change the path, it is used by Caddy to forward the request to the correct port
    path: '/',
    cors: { origin: '*', methods: ['GET', 'POST'] },
    pingTimeout: 60000,
    pingInterval: 25000,
  })

  function handshakeToken(socket: Socket): string | null {
    const auth = (socket.handshake.auth ?? {}) as { token?: unknown }
    if (typeof auth.token === 'string' && auth.token !== '') return auth.token
    const qs = socket.handshake.query as Record<string, unknown>
    const opsToken = qs.opsToken
    if (typeof opsToken === 'string' && opsToken !== '') return opsToken
    // socket.io query 数组形式兼容
    if (Array.isArray(opsToken) && typeof opsToken[0] === 'string') return opsToken[0]
    return null
  }

  const offs = [
    ctx.bus.on('job:update', ({ job }) => io.emit('job:update', job)),
    ctx.bus.on('printer:update', ({ printer }) => io.emit('printer:update', printer)),
    ctx.bus.on('event', ({ event }) => io.emit('event', event)),
    ctx.bus.on('host:update', ({ info }) => io.emit('host:update', info)),
    ctx.bus.on('pairing:update', ({ requests, devices }) => io.emit('pairing:update', { requests, devices })),
    ctx.bus.on('test:progress', ({ run }) => io.emit('test:progress', run)),
    ctx.bus.on('discovery:update', ({ hosts }) => io.emit('discovery:update', { hosts })),
    ctx.bus.on('backend:update', ({ backends }) => io.emit('backend:update', { backends })),
    ctx.bus.on('vipp:update', ({ printer }) => io.emit('vipp:update', printer)),
    ctx.bus.on('scan:update', ({ job }) => io.emit('scan:update', job)),
    ctx.bus.on('snapshot', () => io.emit('snapshot', {})),
    // 启用/重生成令牌 → 断开存量 WS（合法客户端持新令牌自动重连，旧令牌持有者被拒）
    ctx.bus.on('console-auth', ({ enabled }) => {
      if (enabled) io.disconnectSockets(true)
    }),
  ]

  io.on('connection', (socket) => {
    if (ctx.settings.consoleAuthEnabled()) {
      const token = handshakeToken(socket)
      if (!ctx.settings.verifyConsoleToken(token)) {
        socket.emit('auth:error', { code: 'console_auth_required', message: '控制台鉴权已启用：WebSocket 握手缺少有效令牌' })
        socket.disconnect(true)
        return
      }
    }
    socket.emit('welcome', { ...ctx.hostInfo(), wsSocketId: socket.id })
    socket.on('hello', (data: unknown, cb?: (resp: unknown) => void) => {
      cb?.({ ok: true, echo: data, at: new Date().toISOString() })
    })
  })

  server.listen(wsPort)
  console.log(`[ops-host] realtime (socket.io) listening on :${wsPort}`)

  return {
    io,
    server,
    close() {
      offs.forEach((off) => off())
      io.close()
      server.close()
    },
  }
}
