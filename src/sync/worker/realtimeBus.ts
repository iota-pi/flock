import { ItemId } from "src/shared/schemas/items"

export type SyncPingListener = (itemIds: ItemId[]) => void

export const SYNC_PING_CHANNEL_PREFIX = 'flock-sync-ping-bus-'

export function getSyncPingChannelName(accountId: string): string {
  return `${SYNC_PING_CHANNEL_PREFIX}${accountId}`
}

interface AccountBusState {
  channel: BroadcastChannel | null
  hasAttemptedInit: boolean
  listeners: Set<SyncPingListener>
}

const busStateByAccount = new Map<string, AccountBusState>()

function getBusState(accountId: string): AccountBusState {
  let state = busStateByAccount.get(accountId)
  if (!state) {
    state = {
      channel: null,
      hasAttemptedInit: false,
      listeners: new Set(),
    }
    busStateByAccount.set(accountId, state)
  }
  return state
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
      if (event.data?.type === 'sync_ping' && Array.isArray(event.data.itemIds)) {
        for (const listener of state.listeners) {
          try {
            listener(event.data.itemIds)
          } catch (error) {
            console.error('[realtimeBus] Error in SyncPingListener:', error)
          }
        }
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
  if (!accountId) {
    return () => {}
  }
  const state = getBusState(accountId)
  state.listeners.add(listener)
  getChannel(accountId)

  return () => {
    state.listeners.delete(listener)
  }
}

export function publishRealtimeBusSyncPing(
  accountId: string,
  itemIds: ItemId[]
): void {
  if (!accountId || !itemIds || itemIds.length === 0) return

  const channel = getChannel(accountId)
  if (!channel) return

  try {
    channel.postMessage({ type: 'sync_ping', itemIds })
  } catch (error) {
    console.warn('[realtimeBus] Failed to post message to BroadcastChannel:', error)
  }
}

function closeAccountBus(state: AccountBusState): void {
  try {
    state.channel?.close()
  } catch {
    // Ignore close errors
  }
  state.listeners.forEach(l => {
    try {
      state.channel?.removeEventListener?.('message', l as unknown as EventListener)
    } catch {
      // Ignore
    }
  })
  state.listeners.clear()
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

export const closeRealtimeBus = teardownRealtimeBus
