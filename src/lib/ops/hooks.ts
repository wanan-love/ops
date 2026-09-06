'use client'

import { useSyncExternalStore } from 'react'
import { loadDevice, saveDeviceName, getPairedToken, setPairedToken, type DeviceIdentity } from './device'

/**
 * localStorage 派生状态（useSyncExternalStore 实现，SSR 安全且符合 react-hooks 新规则）。
 */

const listeners = new Set<() => void>()

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  window.addEventListener('storage', cb)
  return () => {
    listeners.delete(cb)
    window.removeEventListener('storage', cb)
  }
}

function notify(): void {
  listeners.forEach((l) => l())
}

// ---- 设备身份 ----

const SSR_DEVICE: DeviceIdentity = { deviceId: 'ssr', deviceName: '', platform: 'web' }
let deviceCache: DeviceIdentity | null = null

export function useDevice(): DeviceIdentity {
  return useSyncExternalStore(
    subscribe,
    () => {
      deviceCache ??= loadDevice()
      return deviceCache
    },
    () => SSR_DEVICE,
  )
}

export function useUpdateDeviceName(): (name: string) => DeviceIdentity {
  return (name: string) => {
    const next = saveDeviceName(name)
    deviceCache = next
    notify()
    return next
  }
}

// ---- 配对令牌 ----

let tokenCache: string | null | undefined

export function usePairedToken(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => {
      if (tokenCache === undefined) tokenCache = getPairedToken()
      return tokenCache
    },
    () => null,
  )
}

export function useUpdatePairedToken(): (token: string | null) => void {
  return (token: string | null) => {
    setPairedToken(token)
    tokenCache = token
    notify()
  }
}

// ---- 已保存主机 ----

export interface SavedHost {
  restPort: number
  name: string
  addedAt: string
}

const SAVED_HOSTS_KEY = 'ops.savedHosts'
let savedHostsCache: SavedHost[] | null = null

function readSavedHosts(): SavedHost[] {
  try {
    return JSON.parse(window.localStorage.getItem(SAVED_HOSTS_KEY) ?? '[]') as SavedHost[]
  } catch {
    return []
  }
}

export function useSavedHosts(): SavedHost[] {
  return useSyncExternalStore(
    subscribe,
    () => {
      savedHostsCache ??= readSavedHosts()
      return savedHostsCache
    },
    () => [],
  )
}

export function upsertSavedHost(host: SavedHost): void {
  const saved = readSavedHosts().filter((h) => h.restPort !== host.restPort)
  saved.push(host)
  window.localStorage.setItem(SAVED_HOSTS_KEY, JSON.stringify(saved))
  savedHostsCache = saved
  notify()
}

export function removeSavedHost(port: number): void {
  const saved = readSavedHosts().filter((h) => h.restPort !== port)
  window.localStorage.setItem(SAVED_HOSTS_KEY, JSON.stringify(saved))
  savedHostsCache = saved
  notify()
}
