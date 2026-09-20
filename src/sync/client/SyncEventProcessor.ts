import type { ClientEvent } from '../worker/SyncEventHub'
import { useAppStore } from 'src/state/store'
import type { Item } from 'src/state/items'
import type { ManualRecoveryEntry } from 'src/sync/shared/manualRecoveryStore'
import { recordWorkerActivity } from './syncWorkerHealth'

export interface SyncEventProcessorCallbacks {
  onKeyVersionMissing?: (kver?: string) => void
  onActivity?: () => void
}

export class SyncEventProcessor {
  private readonly ITEM_UPDATE_BATCH_MAX = 50
  private pendingItemUpdates = new Map<string, Item | null>()
  private itemUpdateFlushHandle: ReturnType<typeof setTimeout> | null = null

  private recoveryEntries: ManualRecoveryEntry[] = []
  private recoveryEntriesListeners = new Set<(entries: ManualRecoveryEntry[]) => void>()

  constructor(private callbacks: SyncEventProcessorCallbacks = {}) {}

  setCallbacks(callbacks: SyncEventProcessorCallbacks): void {
    this.callbacks = callbacks
  }

  getRecoveryEntries(): ManualRecoveryEntry[] {
    return this.recoveryEntries
  }

  setRecoveryEntries(entries: ManualRecoveryEntry[]): void {
    this.recoveryEntries = entries
    for (const listener of this.recoveryEntriesListeners) {
      listener(entries)
    }
  }

  subscribeRecoveryItems(listener: (entries: ManualRecoveryEntry[]) => void): () => void {
    this.recoveryEntriesListeners.add(listener)
    listener(this.recoveryEntries)
    return () => {
      this.recoveryEntriesListeners.delete(listener)
    }
  }

  flushItemUpdates = (): void => {
    if (this.pendingItemUpdates.size === 0) return

    const updates = Array.from(this.pendingItemUpdates.entries()).map(([id, item]) => ({ id, item }))
    this.pendingItemUpdates.clear()
    this.itemUpdateFlushHandle = null

    useAppStore.getState().updateItemsFromServer(updates)
  }

  private scheduleItemUpdateFlush = (): void => {
    if (this.itemUpdateFlushHandle !== null) return
    this.itemUpdateFlushHandle = setTimeout(this.flushItemUpdates, 0)
  }

  handleSyncEvent = (event: ClientEvent): void => {
    if (this.callbacks.onActivity) {
      this.callbacks.onActivity()
    } else {
      recordWorkerActivity()
    }
    switch (event.type) {
      case 'ready':
        break
      case 'statusChange':
        useAppStore.getState().setSyncStatus(event.status)
        break
      case 'itemUpdated': {
        const { id, item } = event
        this.pendingItemUpdates.set(id, item)

        if (this.pendingItemUpdates.size >= this.ITEM_UPDATE_BATCH_MAX) {
          if (this.itemUpdateFlushHandle !== null) {
            clearTimeout(this.itemUpdateFlushHandle)
            this.itemUpdateFlushHandle = null
          }
          this.flushItemUpdates()
          return
        }

        this.scheduleItemUpdateFlush()
        break
      }
      case 'indexUpdated':
        useAppStore.getState().updateIndexFromServer(event.itemIds)
        break
      case 'metadataUpdated':
        useAppStore.getState().updateMetadata(event.metadata)
        break
      case 'mutationFailed':
        console.error(`Mutation ${event.mutationType} failed: ${event.error}`)
        break
      case 'startRequest':
        useAppStore.getState().startRequest()
        break
      case 'finishRequest':
        useAppStore.getState().finishRequest()
        break
      case 'authFailure': {
        const syncStore = useAppStore.getState()
        syncStore.setSyncStatus('offline')
        syncStore.setSyncWarning(event.message)
        break
      }
      case 'recoveryItemsChanged':
        this.setRecoveryEntries(event.entries)
        break
      case 'quotaExceeded': {
        const syncStore = useAppStore.getState()
        syncStore.setSyncStatus('degraded')
        syncStore.setSyncWarning(event.message)
        syncStore.setQuotaExceeded(true)
        break
      }
      case 'quotaResolved': {
        const syncStore = useAppStore.getState()
        syncStore.clearQuotaExceeded()
        if (syncStore.syncStatus === 'degraded') {
          syncStore.setSyncStatus('idle')
        }
        if (syncStore.syncWarning?.toLowerCase().includes('quota') || syncStore.syncWarning?.includes('Storage')) {
          syncStore.clearSyncWarning()
        }
        break
      }
      case 'snapshotFailed': {
        const syncStore = useAppStore.getState()
        syncStore.setSyncStatus('degraded')
        syncStore.setSyncWarning(event.message)
        break
      }
      case 'keyVersionMissing':
        this.callbacks.onKeyVersionMissing?.(event.kver)
        break
      case 'leaderConflict': {
        const syncStore = useAppStore.getState()
        syncStore.setLeaderConflict(event.hasConflict)
        break
      }
    }
  }

  reset(clearRecovery = true): void {
    if (this.itemUpdateFlushHandle !== null) {
      clearTimeout(this.itemUpdateFlushHandle)
      this.itemUpdateFlushHandle = null
    }
    this.pendingItemUpdates.clear()

    if (clearRecovery) {
      this.recoveryEntries = []
      for (const listener of this.recoveryEntriesListeners) {
        listener([])
      }
      this.recoveryEntriesListeners.clear()
    }
  }
}
