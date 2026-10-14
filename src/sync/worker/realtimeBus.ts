import { ItemId } from 'src/shared/vault/ids'
import { getVaultStorageNames } from '../shared/storageNames'

export type SyncPingListener = (itemIds: ItemId[]) => void
export type ItemDirtyListener = (itemIds: ItemId[]) => void

export function getSyncPingChannelName(accountId: string): string {
  return `${getVaultStorageNames().accountPrefixes.syncPingChannel}${accountId}`
}

interface AccountBusState {
  channel: BroadcastChannel | null
  hasAttemptedInit: boolean
  listeners: Set<SyncPingListener>
  dirtyListeners: Set<ItemDirtyListener>
}

const busStateByAccount = new Map<string, AccountBusState>()

function getBusState(accountId: string): AccountBusState {
  let state = busStateByAccount.get(accountId)
  if (!state) {
    state = {
      channel: null,
      hasAttemptedInit: false,
      listeners: new Set(),
      dirtyListeners: new Set(),
    }
    busStateByAccount.set(accountId, state)
  }
  return state
}

function notifyListeners(
  listeners: Set<(itemIds: ItemId[]) => void>,
  itemIds: ItemId[],
  listenerName: string,
): void {
  for (const listener of listeners) {
    try {
      listener(itemIds)
    } catch (error) {
      console.error(`[realtimeBus] Error in ${listenerName}:`, error)
    }
  }
}

function getChannel(accountId: string): BroadcastChannel | null {
  if (!accountId) return null
  const state = getBusState(accountId)
  if (state.hasAttemptedInit) {
    return state.channel
  }
  state.hasAttemptedInit = true

  if (typeof BroadcastChannel === 'undefined') {
    return null
  }

  try {
    const channelName = getSyncPingChannelName(accountId)
    const channel = new BroadcastChannel(channelName)
    channel.onmessage = event => {
      if (!Array.isArray(event.data?.itemIds)) return
      if (event.data.type === 'sync_ping') {
        notifyListeners(state.listeners, event.data.itemIds, 'SyncPingListener')
      } else if (event.data.type === 'item_dirty') {
        notifyListeners(state.dirtyListeners, event.data.itemIds, 'ItemDirtyListener')
      }
    }
    channel.onmessageerror = event => {
      console.warn('[realtimeBus] Error deserializing message on BroadcastChannel:', event)
    }
    state.channel = channel
  } catch (error) {
    console.warn('[realtimeBus] BroadcastChannel is not supported or failed to initialize:', error)
    state.channel = null
  }

  return state.channel
}

export function subscribeRealtimeBusSyncPing(
  accountId: string,
  listener: SyncPingListener
): () => void {
  return addListener(accountId, state => state.listeners, listener)
}

/**
 * Subscribes to local edits made by other tabs of this device. The leader uses these to mark
 * items dirty for snapshot upload, since follower tabs cannot upload snapshots themselves.
 */
export function subscribeRealtimeBusItemDirty(
  accountId: string,
  listener: ItemDirtyListener
): () => void {
  return addListener(accountId, state => state.dirtyListeners, listener)
}

function addListener<T>(
  accountId: string,
  getListeners: (state: AccountBusState) => Set<T>,
  listener: T,
): () => void {
  if (!accountId) {
    return () => {}
  }
  const state = getBusState(accountId)
  const listeners = getListeners(state)
  listeners.add(listener)
  getChannel(accountId)

  return () => {
    if (!listeners.has(listener)) {
      return
    }
    listeners.delete(listener)
    if (state.listeners.size === 0 && state.dirtyListeners.size === 0) {
      closeAccountBus(state)
      busStateByAccount.delete(accountId)
    }
  }
}

export function publishRealtimeBusSyncPing(
  accountId: string,
  itemIds: ItemId[]
): void {
  postToBus(accountId, 'sync_ping', itemIds)
}

export function publishRealtimeBusItemDirty(
  accountId: string,
  itemIds: ItemId[]
): void {
  postToBus(accountId, 'item_dirty', itemIds)
}

function postToBus(accountId: string, type: 'sync_ping' | 'item_dirty', itemIds: ItemId[]): void {
  if (!accountId || !itemIds || itemIds.length === 0) return

  const channel = getChannel(accountId)
  if (!channel) return

  try {
    channel.postMessage({ type, itemIds })
  } catch (error) {
    console.warn('[realtimeBus] Failed to post message to BroadcastChannel:', error)
  }
}

function closeAccountBus(state: AccountBusState): void {
  if (state.channel) {
    state.channel.onmessage = null
    state.channel.onmessageerror = null
    try {
      state.channel.close()
    } catch {
      // Ignore close errors
    }
  }
  state.listeners.clear()
  state.dirtyListeners.clear()
  state.channel = null
}

export function teardownRealtimeBus(accountId?: string): void {
  if (accountId) {
    const state = busStateByAccount.get(accountId)
    if (state) {
      closeAccountBus(state)
      busStateByAccount.delete(accountId)
    }
  } else {
    for (const state of busStateByAccount.values()) {
      closeAccountBus(state)
    }
    busStateByAccount.clear()
  }
}
