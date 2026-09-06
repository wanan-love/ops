import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { promises as fs } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import type { HostContext } from '../host'
import { Router, consoleAuthGate, readBody, sendError, sendJson, withCors } from './router'
import { buildRouter } from './routes'

/**
 * REST 层：OPS/1.0 协议（JSON + 原始 PDF 二进制上传）。
 * 网关通过 ?XTransformPort={restPort} 转发到本端口。
 *
 * 打包模式（ctx.webDir 非空）：同时服务随包分发的 Web 控制台静态文件
 * （SPA 回退到 index.html；带哈希的静态资源长缓存；路径遍历防护）。
 */

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
}

function serveStatic(ctx: HostContext, res: ServerResponse, pathname: string): Promise<void> {
  const root = ctx.webDir ? resolve(ctx.webDir) : null
  // 解码 %xx 后规范化，拒绝路径遍历
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    sendError(res, 400, '路径解码失败')
    return Promise.resolve()
  }

  const immutable = pathname.startsWith('/_next/static/') || /\.[0-9a-f]{8,}\.(?:js|css|woff2?|png|svg|jpg|jpeg|webp)$/.test(pathname)
  const sendFile = (data: Buffer | Uint8Array, type: string): void => {
    res.writeHead(200, {
      'content-type': type,
      'content-length': data.byteLength,
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    })
    res.end(data)
  }

  return (async () => {
    // ------------------------------------------------ 1) 磁盘 web 目录（--web / OPS_WEB_DIR）
    if (root) {
      const target = normalize(join(root, decoded))
      if (target !== root && !target.startsWith(root + sep)) {
        sendError(res, 403, '禁止访问 Web 根目录之外的路径')
        return
      }
      const tryFiles = target === root ? [join(root, 'index.html')] : [target, join(target, 'index.html')]
      for (const filePath of tryFiles) {
        let stat: import('node:fs').Stats | null = null
        try {
          stat = await fs.stat(filePath)
        } catch {
          continue
        }
        if (!stat.isFile()) continue
        const ext = extname(filePath).toLowerCase()
        sendFile(await fs.readFile(filePath), MIME_TYPES[ext] ?? 'application/octet-stream')
        return
      }
    }

    // ------------------------------------------------ 2) 嵌入资产（单文件可执行）
    const embedded = ctx.embeddedWeb
    if (embedded && Object.keys(embedded).length > 0) {
      // 命中的清单 key（'/' → '/index.html'）；MIME 必须按实际文件名计算，而非请求路径
      let key: string | undefined = embedded[decoded] ? decoded : undefined
      if (!key && decoded.endsWith('/') && embedded[`${decoded}index.html`]) key = `${decoded}index.html`
      const virtualPath = key ? embedded[key] : undefined
      if (key && virtualPath) {
        try {
          const data = await Bun.file(virtualPath).arrayBuffer()
          const ext = extname(key).toLowerCase()
          sendFile(new Uint8Array(data), MIME_TYPES[ext] ?? 'application/octet-stream')
          return
        } catch {
          /* fallthrough 到 SPA 回退 */
        }
      }
      // SPA 回退：无扩展名的未知路径 → index.html（客户端路由）
      if (!extname(pathname) && embedded['/index.html']) {
        try {
          const data = await Bun.file(embedded['/index.html']).arrayBuffer()
          sendFile(new Uint8Array(data), 'text/html; charset=utf-8')
          return
        } catch {
          /* fallthrough */
        }
      }
    } else if (root && !extname(pathname)) {
      // 磁盘模式 SPA 回退
      const indexPath = join(root, 'index.html')
      try {
        sendFile(await fs.readFile(indexPath), 'text/html; charset=utf-8')
        return
      } catch {
        /* fallthrough */
      }
    }
    sendError(res, 404, `Web 资源不存在：${pathname}`)
  })()
}

export function createRestServer(ctx: HostContext, restPort: number): { server: Server; close(): void } {
  const router: Router = buildRouter()

  /**
   * 控制台鉴权公白白名单（仅鉴权启用时生效）：
   *  - /api/system/info        发现/健康探活（含 consoleAuthEnabled 标志，供客户端渲染解锁界面）
   *  - /api/console/auth       登录校验本身
   *  - /api/console/enable     收紧操作永远允许（防锁定：令牌落盘 data/console-token.txt 可由 Host 所有者恢复）
   *  - /api/pairing/*          设备配对轴（设备令牌体系，与控制台轴独立）
   *  - POST /api/jobs          客户端打印提交（受 securityMode 设备令牌校验，不走控制台轴）
   */
  const PUBLIC_PATHS = new Set<string>(['/api/system/info', '/api/pairing/status'])
  const PUBLIC_POST_PREFIXES = ['/api/console/auth', '/api/console/enable', '/api/pairing/requests']

  function isPublicApiPath(method: string, pathname: string): boolean {
    if (PUBLIC_PATHS.has(pathname)) return true
    if (method === 'POST' && (PUBLIC_POST_PREFIXES.some((p) => pathname === p) || pathname === '/api/jobs')) return true
    return false
  }

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
        // 打包模式：非 /api/* 的 GET/HEAD 请求 → Web 控制台（磁盘目录或内嵌资产）
        if ((ctx.webDir || Object.keys(ctx.embeddedWeb).length > 0) && (req.method === 'GET' || req.method === 'HEAD') && !url.pathname.startsWith('/api/')) {
          if (req.method === 'HEAD') {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
            res.end()
            return
          }
          await serveStatic(ctx, res, url.pathname)
          return
        }
        if (url.pathname === '/' || url.pathname === '/healthz') {
          sendJson(res, 200, { ok: true, service: 'openprintshare-host', api: 'OPS/1.0', restPort, wsPort: ctx.wsPort, version: ctx.hostInfo().version })
          return
        }
        sendError(res, 404, `未找到路由：${req.method} ${url.pathname}`)
        return
      }

      // 控制台鉴权门（P2 安全轮）：白名单外全部需要有效令牌
      if (!isPublicApiPath(req.method ?? 'GET', url.pathname) && !consoleAuthGate(ctx, req, res, url.searchParams)) return

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
  console.log(`[ops-host] REST (OPS/1.0) listening on :${restPort}${ctx.webDir || Object.keys(ctx.embeddedWeb).length > 0 ? ` (+ Web console http://localhost:${restPort}/)` : ''}`)

  return {
    server,
    close() {
      server.close()
    },
  }
}
