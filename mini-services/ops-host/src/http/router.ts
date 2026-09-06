import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HostContext } from '../host'

export type RouteHandler = (
  ctx: HostContext,
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  query: URLSearchParams,
  body: Buffer,
) => Promise<void> | void

interface Route {
  method: string
  pattern: RegExp
  keys: string[]
  handler: RouteHandler
}

export class Router {
  private routes: Route[] = []

  add(method: string, path: string, handler: RouteHandler): void {
    const keys: string[] = []
    const regexSrc = path
      .split('/')
      .map((seg) => {
        if (seg.startsWith(':')) {
          keys.push(seg.slice(1))
          return '([^/]+)'
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      })
      .join('/')
    this.routes.push({ method, pattern: new RegExp(`^${regexSrc}/?$`), keys, handler })
  }

  get(path: string, handler: RouteHandler): void {
    this.add('GET', path, handler)
  }

  post(path: string, handler: RouteHandler): void {
    this.add('POST', path, handler)
  }

  patch(path: string, handler: RouteHandler): void {
    this.add('PATCH', path, handler)
  }

  delete(path: string, handler: RouteHandler): void {
    this.add('DELETE', path, handler)
  }

  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
    for (const route of this.routes) {
      if (route.method !== method) continue
      const m = route.pattern.exec(pathname)
      if (!m) continue
      const params: Record<string, string> = {}
      route.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1])
      })
      return { route, params }
    }
    return null
  }
}

// ---------------------------------------------------------------- helpers

const MAX_BODY_BYTES = 20 * 1024 * 1024 // 20MB（原始 PDF）

export function sendJson(res: ServerResponse, code: number, data: unknown): void {
  const body = JSON.stringify(data)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

export function sendError(res: ServerResponse, code: number, message: string): void {
  sendJson(res, code, { error: message })
}

export async function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        reject(new Error('Payload too large (max 20MB)'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export function parseJsonBody<T>(body: Buffer): T | null {
  if (body.length === 0) return null
  try {
    return JSON.parse(body.toString('utf8')) as T
  } catch {
    return null
  }
}

/** 解析 URL 编码的 header 值（含非 ASCII 设备名） */
export function headerString(req: IncomingMessage, name: string, fallback = ''): string {
  const raw = req.headers[name]
  if (typeof raw !== 'string' || raw === '') return fallback
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

export function withCors(res: ServerResponse): void {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS')
  res.setHeader('access-control-allow-headers', 'content-type,x-ops-token,x-ops-options,x-ops-device,x-ops-device-name,x-ops-platform,x-ops-admin')
  res.setHeader('access-control-expose-headers', 'content-disposition')
}
