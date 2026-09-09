import { ItemId } from "src/shared/schemas/items"

type SyncPingListener = (itemIds: ItemId[]) => void

const CHANNEL_NAME = 'flock-sync-ping-bus'
let broadcastChannel: BroadcastChannel | null = null
let hasAttemptedInit = false
const listeners = new Set<SyncPingListener>()

function getChannel(): BroadcastChannel | null {
  if (hasAttemptedInit) {
    return broadcastChannel
  }
  hasAttemptedInit = true

  if (typeof BroadcastChannel === 'undefined') {
    return null
  }

  try {
    const channel = new BroadcastChannel(CHANNEL_NAME)
    channel.onmessage = event => {
      if (event.data?.type === 'sync_ping' && Array.isArray(event.data.itemIds)) {
        for (const listener of listeners) {
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
    broadcastChannel = channel
  } catch (error) {
    console.warn('[realtimeBus] BroadcastChannel is not supported or failed to initialize:', error)
    broadcastChannel = null
  }

  return broadcastChannel
}

export function subscribeRealtimeBusSyncPing(listener: SyncPingListener): () => void {
  listeners.add(listener)
  getChannel()

  return () => {
    listeners.delete(listener)
  }
}

export function publishRealtimeBusSyncPing(itemIds: ItemId[]): void {
  if (!itemIds || itemIds.length === 0) return

  const channel = getChannel()
  if (!channel) return

  try {
    channel.postMessage({ type: 'sync_ping', itemIds })
  } catch (error) {
    console.warn('[realtimeBus] Failed to post message to BroadcastChannel:', error)
  }
}

