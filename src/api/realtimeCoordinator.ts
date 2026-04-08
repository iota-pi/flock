import env from '../env'
import type {
  RealtimeEventEnvelope,
} from '../shared/realtime'
import {
  pullRemoteMessagesNow,
  requestAutomergeSync,
  startAutomergeSyncDispatcher,
  stopAutomergeSyncDispatcher,
} from '../sync/automergeSyncDispatcher'
import {
  postRealtimeBusEvent,
  startRealtimeBus,
  stopRealtimeBus,
  subscribeRealtimeBusSyncPing,
} from '../sync/realtimeBus'
import { getApiAuthToken } from './runtime'
import { BrowserLockManager } from './realtime/browserLockManager'
import { normalizeRealtimeItemIds, parseRealtimePayload } from './realtime/payload'
import { RealtimeWebSocketTransport } from './realtime/realtimeWebSocketTransport'

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

    const updatedItemIds = normalizeRealtimeItemIds(data.itemIds)
    const deletedItemIds = normalizeRealtimeItemIds(data.deletedItemIds)

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
function createWebLockCoordinator(options: RealtimeCoordinatorOptions): RealtimeCoordinatorHandle {
  const account = options.account
  const lockName = `flock-realtime-lock:${account}`

  startRealtimeBus(account)
  const unsubscribeSyncPing = options.onSyncPing
    ? subscribeRealtimeBusSyncPing(options.onSyncPing)
    : () => undefined

  let stopped = false

  const runRemotePull = (itemIds: string[]) => {
    const normalizedItemIds = normalizeRealtimeItemIds(itemIds)
    if (normalizedItemIds.length === 0) {
      return
    }

    void pullRemoteMessagesNow(normalizedItemIds).then(updatedItemIds => {
      const normalizedUpdatedIds = normalizeRealtimeItemIds(updatedItemIds)
      if (normalizedUpdatedIds.length === 0) {
        return
      }

      postRealtimeBusEvent({
        type: 'REMOTE_UPDATED',
        itemIds: normalizedUpdatedIds,
      })
    }).catch(() => undefined)
  }

  const transport = new RealtimeWebSocketTransport({
    account,
    endpoint: env.VAULT_WS_ENDPOINT,
    getLastEventId: () => readLastEventId(account),
    getToken: getApiAuthToken,
    onOpen: () => {
      requestAutomergeSync()
    },
    onRawMessage: rawData => {
      const payload = parseRealtimePayload(rawData)
      if (!payload) {
        return
      }

      if ('action' in payload && payload.action === 'sync_ping') {
        const pingItemIds = normalizeRealtimeItemIds(payload.itemIds)
        postRealtimeBusEvent({
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
    },
  })

  const stopLeader = () => {
    transport.stop()
    stopAutomergeSyncDispatcher()
  }

  const startLeader = () => {
    startAutomergeSyncDispatcher(account)
    transport.start()
    requestAutomergeSync()
  }

  const lockManager = new BrowserLockManager(lockName)
  lockManager.start({
    startLeader,
    stopLeader,
  })

  return {
    stop: () => {
      if (stopped) {
        return
      }

      stopped = true
      lockManager.stop()

      unsubscribeSyncPing()
      stopRealtimeBus()
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
