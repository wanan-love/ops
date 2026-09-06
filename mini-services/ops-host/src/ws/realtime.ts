import { createServer, type Server as HttpServer } from 'node:http'
import { Server as IOServer } from 'socket.io'
import type { HostContext } from '../host'

/**
 * 实时层：socket.io（path 必须为 '/'，网关按 ?XTransformPort={wsPort} 转发）。
 * 由于 engine.io 在 path '/' 下接管整个端口，实时服务独立监听 wsPort（REST 在 restPort）。
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

  const offs = [
    ctx.bus.on('job:update', ({ job }) => io.emit('job:update', job)),
    ctx.bus.on('printer:update', ({ printer }) => io.emit('printer:update', printer)),
    ctx.bus.on('event', ({ event }) => io.emit('event', event)),
    ctx.bus.on('host:update', ({ info }) => io.emit('host:update', info)),
    ctx.bus.on('pairing:update', ({ requests, devices }) => io.emit('pairing:update', { requests, devices })),
    ctx.bus.on('test:progress', ({ run }) => io.emit('test:progress', run)),
    ctx.bus.on('discovery:update', ({ hosts }) => io.emit('discovery:update', { hosts })),
    ctx.bus.on('snapshot', () => io.emit('snapshot', {})),
  ]

  io.on('connection', (socket) => {
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
