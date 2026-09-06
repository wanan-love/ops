import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { HostContext } from '../host'
import { Router, readBody, sendError, sendJson, withCors } from './router'
import { buildRouter } from './routes'

/**
 * REST 层：OPS/1.0 协议（JSON + 原始 PDF 二进制上传）。
 * 网关通过 ?XTransformPort={restPort} 转发到本端口。
 */
export function createRestServer(ctx: HostContext, restPort: number): { server: Server; close(): void } {
  const router: Router = buildRouter()

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    withCors(res)
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      const match = router.match(req.method ?? 'GET', url.pathname)

      if (!match) {
        if (url.pathname === '/' || url.pathname === '/healthz') {
          sendJson(res, 200, { ok: true, service: 'openprintshare-host', api: 'OPS/1.0', restPort, wsPort: ctx.wsPort, version: ctx.hostInfo().version })
          return
        }
        sendError(res, 404, `未找到路由：${req.method} ${url.pathname}`)
        return
      }

      // POST/ PATCH/ DELETE 带 body 的统一读取（PDF 原始字节或 JSON）
      const hasBody = req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT'
      const body = hasBody ? await readBody(req) : Buffer.alloc(0)
      await match.route.handler(ctx, req, res, match.params, url.searchParams, body)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[ops-host] ${req.method} ${req.url} → 500:`, message)
      if (!res.headersSent) {
        sendError(res, 500, `内部错误：${message}`)
      } else {
        res.end()
      }
    }
  })

  server.listen(restPort)
  console.log(`[ops-host] REST (OPS/1.0) listening on :${restPort}`)

  return {
    server,
    close() {
      server.close()
    },
  }
}
