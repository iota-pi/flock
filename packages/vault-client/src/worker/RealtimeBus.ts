import type { ItemId } from '@vault/shared'
import type { VaultMetadata } from '../shared/types'
import { getVaultStorageNames } from '../shared/storageNames'
import { createLogger } from '../utils/logger'

const log = createLogger('RealtimeBus')

type ItemIdsListener = (itemIds: ItemId[]) => void
type MetadataListener = (metadata: VaultMetadata) => void

export function getSyncPingChannelName(accountId: string): string {
  return `${getVaultStorageNames().accountPrefixes.syncPingChannel}${accountId}`
}

export function getIndexChannelName(accountId: string): string {
  return `${getVaultStorageNames().accountPrefixes.indexChannel}${accountId}`
}

function notifyListeners<T>(listeners: Set<(value: T) => void>, value: T, listenerName: string): void {
  for (const listener of listeners) {
    try {
      listener(value)
    } catch (error) {
      log.error(`Error in ${listenerName}:`, error)
    }
  }
}

function openChannel(name: string, onMessage: (data: unknown) => void): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') {
    return null
  }
  try {
    const channel = new BroadcastChannel(name)
    channel.onmessage = event => onMessage(event.data)
    channel.onmessageerror = event => {
      log.warn('Error deserializing message on BroadcastChannel:', event)
    }
    return channel
  } catch (error) {
    log.warn('BroadcastChannel is not supported or failed to initialize:', error)
    return null
  }
}

function closeChannel(channel: BroadcastChannel | null): void {
  if (!channel) return
  channel.onmessage = null
  channel.onmessageerror = null
  try {
    channel.close()
  } catch {
    // Ignore close errors
  }
}

function postToChannel(channel: BroadcastChannel | null, message: unknown): void {
  if (!channel) return
  try {
    channel.postMessage(message)
  } catch (error) {
    log.warn('Failed to post message to BroadcastChannel:', error)
  }
}

/**
 * Tells this account's other tabs on the device what this tab did: items synced (`sync_ping`), items
 * edited (`item_dirty`, so the leader uploads their snapshots), and index and metadata changes. Each
 * session's context owns one and closes it when it stops. Index and metadata messages keep their own
 * channel, so tabs running an earlier release still hear them.
 */
export class RealtimeBus {
  private syncChannel: BroadcastChannel | null
  private indexChannel: BroadcastChannel | null
  private readonly syncPingListeners = new Set<ItemIdsListener>()
  private readonly itemDirtyListeners = new Set<ItemIdsListener>()
  private readonly indexListeners = new Set<ItemIdsListener>()
  private readonly metadataListeners = new Set<MetadataListener>()

  constructor(accountId: string) {
    this.syncChannel = openChannel(getSyncPingChannelName(accountId), data => this.handleSyncMessage(data))
    this.indexChannel = openChannel(getIndexChannelName(accountId), data => this.handleIndexMessage(data))
  }

  private handleSyncMessage(data: unknown): void {
    const message = data as { type?: string; itemIds?: unknown } | null
    if (!Array.isArray(message?.itemIds)) return
    const itemIds = message.itemIds as ItemId[]
    if (message.type === 'sync_ping') {
      notifyListeners(this.syncPingListeners, itemIds, 'SyncPingListener')
    } else if (message.type === 'item_dirty') {
      notifyListeners(this.itemDirtyListeners, itemIds, 'ItemDirtyListener')
    }
  }

  private handleIndexMessage(data: unknown): void {
    const message = data as { type?: string; itemIds?: unknown; metadata?: VaultMetadata } | null
    if (message?.type === 'indexUpdated' && Array.isArray(message.itemIds)) {
      notifyListeners(this.indexListeners, message.itemIds as ItemId[], 'IndexListener')
    } else if (message?.type === 'metadataUpdated' && message.metadata) {
      notifyListeners(this.metadataListeners, message.metadata, 'MetadataListener')
    }
  }

  /** Items another tab synced */
  subscribeSyncPing(listener: ItemIdsListener): () => void {
    return addListener(this.syncPingListeners, listener)
  }

  /** Items another tab edited. The leader marks them dirty, since followers can't upload snapshots. */
  subscribeItemDirty(listener: ItemIdsListener): () => void {
    return addListener(this.itemDirtyListeners, listener)
  }

  /** Another tab's index */
  subscribeIndexUpdated(listener: ItemIdsListener): () => void {
    return addListener(this.indexListeners, listener)
  }

  /** Another tab's local metadata */
  subscribeMetadataUpdated(listener: MetadataListener): () => void {
    return addListener(this.metadataListeners, listener)
  }

  publishSyncPing(itemIds: ItemId[]): void {
    if (itemIds.length === 0) return
    postToChannel(this.syncChannel, { type: 'sync_ping', itemIds })
  }

  publishItemDirty(itemIds: ItemId[]): void {
    if (itemIds.length === 0) return
    postToChannel(this.syncChannel, { type: 'item_dirty', itemIds })
  }

  publishIndexUpdated(itemIds: ItemId[]): void {
    postToChannel(this.indexChannel, { type: 'indexUpdated', itemIds })
  }

  publishMetadataUpdated(metadata: VaultMetadata): void {
    postToChannel(this.indexChannel, { type: 'metadataUpdated', metadata })
  }

  /** Closes the channels and drops every listener */
  close(): void {
    closeChannel(this.syncChannel)
    closeChannel(this.indexChannel)
    this.syncChannel = null
    this.indexChannel = null
    this.syncPingListeners.clear()
    this.itemDirtyListeners.clear()
    this.indexListeners.clear()
    this.metadataListeners.clear()
  }
}

function addListener<T>(listeners: Set<T>, listener: T): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
