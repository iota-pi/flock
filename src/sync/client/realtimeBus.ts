import { ItemId } from "src/shared/schemas/items"

type SyncPingListener = (itemIds: ItemId[]) => void

const CHANNEL_NAME = 'flock-sync-ping-bus'
let broadcastChannel: BroadcastChannel | null = null
const listeners = new Set<SyncPingListener>()

function getChannel(): BroadcastChannel {
  if (!broadcastChannel) {
    broadcastChannel = new BroadcastChannel(CHANNEL_NAME)
    broadcastChannel.onmessage = event => {
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
  }
  return broadcastChannel
}

export function subscribeRealtimeBusSyncPing(listener: SyncPingListener): () => void {
  listeners.add(listener)
  void getChannel()

  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && broadcastChannel) {
      broadcastChannel.close()
      broadcastChannel = null
    }
  }
}

export function publishRealtimeBusSyncPing(itemIds: ItemId[]): void {
  if (!itemIds || itemIds.length === 0) return

  if (broadcastChannel) {
    broadcastChannel.postMessage({ type: 'sync_ping', itemIds })
  } else {
    const channel = new BroadcastChannel(CHANNEL_NAME)
    try {
      channel.postMessage({ type: 'sync_ping', itemIds })
    } finally {
      channel.close()
    }
  }
}
