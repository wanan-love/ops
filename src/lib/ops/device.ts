'use client'

/** 浏览器设备身份（deviceId 持久化于 localStorage，用于任务来源与配对） */

export interface DeviceIdentity {
  deviceId: string
  deviceName: string
  platform: 'web'
}

const DEVICE_KEY = 'ops.device'
const TOKEN_KEY = 'ops.token'
const CONSOLE_TOKEN_KEY = 'ops.consoleToken'

function randomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `dev-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
}

export function loadDevice(): DeviceIdentity {
  if (typeof window === 'undefined') return { deviceId: 'ssr', deviceName: 'SSR', platform: 'web' }
  try {
    const raw = window.localStorage.getItem(DEVICE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as DeviceIdentity
      if (parsed.deviceId) return parsed
    }
  } catch {
    /* corrupted → recreate */
  }
  const device: DeviceIdentity = {
    deviceId: randomId(),
    deviceName: `Web 客户端-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    platform: 'web',
  }
  window.localStorage.setItem(DEVICE_KEY, JSON.stringify(device))
  return device
}

export function saveDeviceName(name: string): DeviceIdentity {
  const device = loadDevice()
  const next = { ...device, deviceName: name.slice(0, 60) || device.deviceName }
  window.localStorage.setItem(DEVICE_KEY, JSON.stringify(next))
  return next
}

export function getPairedToken(): string | null {
  if (typeof window === 'undefined') return null
  return window.localStorage.getItem(TOKEN_KEY)
}

export function setPairedToken(token: string | null): void {
  if (typeof window === 'undefined') return
  if (token) window.localStorage.setItem(TOKEN_KEY, token)
  else window.localStorage.removeItem(TOKEN_KEY)
}

// ---- 控制台访问令牌（P2 安全轮：管理面鉴权，与设备配对令牌相互独立） ----

export function getConsoleToken(): string | null {
  if (typeof window === 'undefined') return null
  return window.localStorage.getItem(CONSOLE_TOKEN_KEY)
}

export function setConsoleToken(token: string | null): void {
  if (typeof window === 'undefined') return
  if (token) window.localStorage.setItem(CONSOLE_TOKEN_KEY, token)
  else window.localStorage.removeItem(CONSOLE_TOKEN_KEY)
}
