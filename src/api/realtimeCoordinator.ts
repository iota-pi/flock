import env from '../env'
import type {
  RealtimeBusEvent,
  RealtimeEventEnvelope,
  RealtimeSyncPing,
} from '../shared/realtime'
import { invalidateCachedItems } from '../sync/automergeDocStore'
import {
  pullRemoteMessagesNow,
  requestAutomergeSync,
  startAutomergeSyncDispatcher,
  stopAutomergeSyncDispatcher,
} from '../sync/automergeSyncDispatcher'
import { createRealtimeBusChannel, isRealtimeBusEvent, postRealtimeBusEvent } from '../sync/realtimeBus'
import { getApiAuthToken } from './runtime'

type RealtimeCoordinatorOptions = {
  account: string
  onServerEvent: (event: RealtimeEventEnvelope) => void
  onItemsChanged?: (payload: { updatedItemIds: string[]; deletedItemIds: string[] }) => void
  onItemEvents?: (events: RealtimeEventEnvelope[]) => void
  onSyncPing?: (itemIds: string[]) => void
}

type RealtimeCoordinatorHandle = {
  stop: () => void
}

const RECONNECT_BASE_DELAY_MS = 1000
const RECONNECT_MAX_DELAY_MS = 30000

let activeHandle: RealtimeCoordinatorHandle | null = null
let activeKey = ''

function getLastEventIdStorageKey(account: string): string {
  return `realtime:lastEventId:${account}`
}

function readLastEventId(account: string): number {
  if (typeof window === 'undefined' || !window.localStorage) {
    return 0
  }

  const rawValue = window.localStorage.getItem(getLastEventIdStorageKey(account))
  const parsed = Number(rawValue)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0
  }

  return parsed
}

function writeLastEventId(account: string, eventId: number): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }

  window.localStorage.setItem(getLastEventIdStorageKey(account), String(eventId))
}

function normalizeItemIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  const normalized = new Set<string>()
  for (const candidate of value) {
    if (typeof candidate !== 'string' || candidate.length === 0) {
      continue
    }

    normalized.add(candidate)
  }

  return Array.from(normalized)
}

function handleServerEvent(
  event: RealtimeEventEnvelope,
  options: Pick<RealtimeCoordinatorOptions, 'account' | 'onServerEvent' | 'onItemsChanged' | 'onItemEvents'>,
): void {
  if (event.account !== options.account) {
    return
  }

  if (event.eventType === 'items.updated' || event.eventType === 'items.deleted') {
    const data = (event.data || {}) as {
      itemIds?: unknown
      deletedItemIds?: unknown
    }

    const updatedItemIds = normalizeItemIds(data.itemIds)
    const deletedItemIds = normalizeItemIds(data.deletedItemIds)

    if (updatedItemIds.length > 0 || deletedItemIds.length > 0) {
      options.onItemsChanged?.({
        updatedItemIds,
        deletedItemIds,
      })

      options.onItemEvents?.([{
        ...event,
        data: {
          itemIds: updatedItemIds,
          deletedItemIds,
        },
      }])
    }
  }

  if (typeof event.eventId === 'number' && event.eventId > 0) {
    writeLastEventId(options.account, event.eventId)
  }

  options.onServerEvent(event)
}

function parseServerPayload(rawData: string | null | undefined): RealtimeEventEnvelope | RealtimeSyncPing | null {
  if (!rawData) {
    return null
  }

  try {
    const payload = JSON.parse(rawData) as RealtimeEventEnvelope | RealtimeSyncPing

    if ('action' in payload && payload.action === 'sync_ping') {
      return payload
    }

    if ('eventType' in payload && 'account' in payload) {
      return payload
    }

    return null
  } catch {
    return null
  }
}

function createWebLockCoordinator(options: RealtimeCoordinatorOptions): RealtimeCoordinatorHandle {
  const account = options.account
  const lockName = `flock-realtime-lock:${account}`

  const bus = createRealtimeBusChannel(account)

  let stopped = false
  let reconnectAttempts = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let socket: WebSocket | null = null
  let releaseLeadership: (() => void) | null = null
  const lockAbortController = typeof AbortController !== 'undefined'
    ? new AbortController()
    : null

  const clearReconnectTimer = () => {
    if (!reconnectTimer) {
      return
    }

    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  const closeWebSocket = () => {
    if (!socket) {
      return
    }

    socket.close()
    socket = null
  }

  const runRemotePull = (itemIds: string[]) => {
    const normalizedItemIds = normalizeItemIds(itemIds)
    if (normalizedItemIds.length === 0) {
      return
    }

    void pullRemoteMessagesNow(normalizedItemIds).then(updatedItemIds => {
      const normalizedUpdatedIds = normalizeItemIds(updatedItemIds)
      if (normalizedUpdatedIds.length === 0) {
        return
      }

      const busEvent: RealtimeBusEvent = {
        type: 'REMOTE_UPDATED',
        itemIds: normalizedUpdatedIds,
      }

      postRealtimeBusEvent(account, busEvent)
    }).catch(() => undefined)
  }

  const scheduleReconnect = () => {
    clearReconnectTimer()
    if (stopped) {
      return
    }

    reconnectAttempts += 1
    const backoff = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * (2 ** (reconnectAttempts - 1)))
    const jitter = Math.random() * 0.2 * backoff
    const delay = Math.floor(backoff + jitter)

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connectWebSocket()
    }, delay)
  }

  function connectWebSocket(): void {
    if (stopped) {
      return
    }

    closeWebSocket()

    const token = getApiAuthToken()
    if (!token || !env.VAULT_WS_ENDPOINT) {
      scheduleReconnect()
      return
    }

    const params = new URLSearchParams({
      account,
      token,
    })

    const lastEventId = readLastEventId(account)
    if (lastEventId > 0) {
      params.set('lastEventId', String(lastEventId))
    }

    const wsEndpoint = env.VAULT_WS_ENDPOINT.replace(/^http/i, 'ws')
    const nextSocket = new WebSocket(`${wsEndpoint}?${params.toString()}`)
    socket = nextSocket

    nextSocket.onopen = () => {
      reconnectAttempts = 0
      requestAutomergeSync()
    }

    nextSocket.onmessage = event => {
      const payload = parseServerPayload(typeof event.data === 'string' ? event.data : null)
      if (!payload) {
        return
      }

      if ('action' in payload && payload.action === 'sync_ping') {
        const pingItemIds = normalizeItemIds(payload.itemIds)
        postRealtimeBusEvent(account, {
          type: 'SYNC_PING',
          itemIds: pingItemIds,
        })

        options.onSyncPing?.(pingItemIds)
        runRemotePull(pingItemIds)
        return
      }

      if ('eventType' in payload && 'account' in payload) {
        handleServerEvent(payload, options)
      }
    }

    nextSocket.onerror = () => {
      closeWebSocket()
      scheduleReconnect()
    }

    nextSocket.onclose = () => {
      closeWebSocket()
      scheduleReconnect()
    }
  }

  const stopLeader = () => {
    clearReconnectTimer()
    closeWebSocket()
    stopAutomergeSyncDispatcher()
  }

  const startLeader = () => {
    startAutomergeSyncDispatcher(account)
    connectWebSocket()
    requestAutomergeSync()
  }

  if (bus) {
    bus.onmessage = event => {
      if (!isRealtimeBusEvent(event.data)) {
        return
      }

      if (event.data.type === 'REMOTE_UPDATED') {
        invalidateCachedItems(event.data.itemIds)
        return
      }

      if (event.data.type === 'SYNC_PING') {
        options.onSyncPing?.(event.data.itemIds)
      }
    }
  }

  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    void navigator.locks.request(lockName, {
      signal: lockAbortController?.signal,
    }, async () => {
      if (stopped) {
        return
      }

      startLeader()

      await new Promise<void>(resolve => {
        releaseLeadership = () => {
          if (!releaseLeadership) {
            return
          }

          releaseLeadership = null
          stopLeader()
          resolve()
        }
      })
    }).catch(() => {
      stopLeader()
    })
  } else {
    startLeader()
  }

  return {
    stop: () => {
      if (stopped) {
        return
      }

      stopped = true
      clearReconnectTimer()

      if (releaseLeadership) {
        releaseLeadership()
      } else {
        stopLeader()
      }

      if (lockAbortController) {
        lockAbortController.abort()
      }

      if (bus) {
        bus.close()
      }
    },
  }
}

export function startRealtimeCoordinator(options: RealtimeCoordinatorOptions): void {
  const key = `${options.account}:${getApiAuthToken()}`
  if (activeHandle && activeKey === key) {
    return
  }

  stopRealtimeCoordinator()

  if (typeof window === 'undefined') {
    return
  }

  activeKey = key
  activeHandle = createWebLockCoordinator(options)
}

export function stopRealtimeCoordinator(): void {
  if (!activeHandle) {
    return
  }

  activeHandle.stop()
  activeHandle = null
  activeKey = ''
}
