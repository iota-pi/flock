import type { ItemId } from '@vault/shared'
import type { VaultMetadata } from '../shared/types'
import { getVaultStorageNames } from '../shared/storageNames'
import { createLogger } from '../utils/logger'

const log = createLogger('RealtimeBus')

type ItemIdsListener = (itemIds: ItemId[]) => void
type MetadataListener = (metadata: VaultMetadata) => void

/** A tab's visibility, which it sends when it changes and regularly while it's visible */
export interface TabVisibility {
  tabId: string
  visible: boolean
  /** The user just came back to the tab (it became visible or got focus), so the leader should poll */
  returned: boolean
  /** The user is using the tab, so the leader should poll at the active rate */
  active?: boolean
  /** The tab leads, so a tab the user comes back to while it's hidden takes over */
  leader?: boolean
}
type TabVisibilityListener = (visibility: TabVisibility) => void

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
 * Tells this account's other tabs on the device what this tab did: items synced (`sync_ping`), whether
 * it's visible (`tab_visibility`, so the leader polls at the foreground rate), and index and metadata
 * changes. Edits need no message: the leader marks an item dirty as it records its push (see
 * `ChangeOutbox`), and ignores the `item_dirty` messages tabs of earlier releases still send. Each
 * session's context owns one and closes it when it stops. Index and metadata messages keep their own
 * channel, so tabs running an earlier release still hear them.
 */
export class RealtimeBus {
  private syncChannel: BroadcastChannel | null
  private indexChannel: BroadcastChannel | null
  private readonly syncPingListeners = new Set<ItemIdsListener>()
  private readonly indexListeners = new Set<ItemIdsListener>()
  private readonly metadataListeners = new Set<MetadataListener>()
  private readonly tabVisibilityListeners = new Set<TabVisibilityListener>()

  constructor(accountId: string) {
    this.syncChannel = openChannel(getSyncPingChannelName(accountId), data => this.handleSyncMessage(data))
    this.indexChannel = openChannel(getIndexChannelName(accountId), data => this.handleIndexMessage(data))
  }

  private handleSyncMessage(data: unknown): void {
    const message = data as { type?: string; itemIds?: unknown } & Partial<TabVisibility> | null
    if (message?.type === 'tab_visibility') {
      if (typeof message.tabId !== 'string') return
      const visibility = {
        tabId: message.tabId,
        visible: !!message.visible,
        returned: !!message.returned,
        active: !!message.active,
        leader: !!message.leader,
      }
      notifyListeners(this.tabVisibilityListeners, visibility, 'TabVisibilityListener')
      return
    }
    if (!Array.isArray(message?.itemIds)) return
    const itemIds = message.itemIds as ItemId[]
    if (message.type === 'sync_ping') {
      notifyListeners(this.syncPingListeners, itemIds, 'SyncPingListener')
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

  /** Another tab's visibility */
  subscribeTabVisibility(listener: TabVisibilityListener): () => void {
    return addListener(this.tabVisibilityListeners, listener)
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

  publishTabVisibility(visibility: TabVisibility): void {
    postToChannel(this.syncChannel, { type: 'tab_visibility', ...visibility })
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
    this.indexListeners.clear()
    this.metadataListeners.clear()
    this.tabVisibilityListeners.clear()
  }
}

function addListener<T>(listeners: Set<T>, listener: T): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
