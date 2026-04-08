import type { RealtimeBusEvent } from '../shared/realtime'
import { invalidateCachedItems } from './automergeDocStore'

const REALTIME_BUS_PREFIX = 'flock-realtime-bus'

let activeChannel: BroadcastChannel | null = null
let activeAccount: string | null = null
let localEditHandler: ((itemId: string) => void) | null = null
const syncPingListeners = new Set<(itemIds: string[]) => void>()

function getRealtimeBusChannelName(account: string): string {
  return `${REALTIME_BUS_PREFIX}:${account}`
}

export function isRealtimeBusEvent(value: unknown): value is RealtimeBusEvent {
  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as { type?: unknown; itemId?: unknown; itemIds?: unknown }

  if (candidate.type === 'LOCAL_EDIT') {
    return typeof candidate.itemId === 'string' && candidate.itemId.length > 0
  }

  if (candidate.type === 'REMOTE_UPDATED' || candidate.type === 'SYNC_PING') {
    return Array.isArray(candidate.itemIds)
      && candidate.itemIds.every(itemId => typeof itemId === 'string' && itemId.length > 0)
  }

  return false
}

function handleRealtimeBusEvent(event: RealtimeBusEvent): void {
  if (event.type === 'LOCAL_EDIT') {
    localEditHandler?.(event.itemId)
    return
  }

  if (event.type === 'REMOTE_UPDATED') {
    invalidateCachedItems(event.itemIds)
    return
  }

  for (const listener of syncPingListeners) {
    listener(event.itemIds)
  }
}

export function startRealtimeBus(account: string): void {
  if (!account || typeof BroadcastChannel === 'undefined') {
    return
  }

  if (activeChannel && activeAccount === account) {
    return
  }

  stopRealtimeBus()

  activeAccount = account
  activeChannel = new BroadcastChannel(getRealtimeBusChannelName(account))
  activeChannel.onmessage = event => {
    if (!isRealtimeBusEvent(event.data)) {
      return
    }

    handleRealtimeBusEvent(event.data)
  }
}

export function stopRealtimeBus(): void {
  if (activeChannel) {
    activeChannel.close()
    activeChannel = null
  }

  activeAccount = null
  localEditHandler = null
  syncPingListeners.clear()
}

export function postRealtimeBusEvent(event: RealtimeBusEvent): void {
  if (!activeChannel) {
    return
  }

  activeChannel.postMessage(event)
}

export function setRealtimeBusLocalEditHandler(handler: ((itemId: string) => void) | null): void {
  localEditHandler = handler
}

export function subscribeRealtimeBusSyncPing(listener: (itemIds: string[]) => void): () => void {
  syncPingListeners.add(listener)

  return () => {
    syncPingListeners.delete(listener)
  }
}

export function hasActiveRealtimeBus(): boolean {
  return !!activeChannel
}

export function getActiveRealtimeBusAccount(): string | null {
  return activeAccount
}
