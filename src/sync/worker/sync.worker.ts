/// <reference lib="webworker" />
import * as Comlink from 'comlink'
import * as Automerge from '@automerge/automerge/slim'
import wasmUrl from '@automerge/automerge/automerge.wasm?url'

import type { SyncApi } from './syncProtocol'
import { ClientEventHub, WorkerInternalEventHub, type ClientEvent, type WorkerInternalEvent } from './SyncEventHub'
import type { Item } from '../../state/items'
import type { AccountMetadata } from '../../state/metadata'
import { subscribeRealtimeBusSyncPing } from '../client/realtimeBus'
import { initWorkerVault } from '../../api/vault'
import { AutomergeRepoManager } from './AutomergeRepoManager'
import { VaultNetworkAdapter } from './VaultEncryptedNetworkAdapter'
import { SyncMessageBroker } from './SyncMessageBroker'
import type { SyncStatus } from '../../state/slices/syncSlice'
import { registerQuotaReporter, resetQuotaExceededStatus } from '../../utils/storageManager'
import { type BackupSyncState } from '../../types/backup'
import { ItemId } from 'src/shared/schemas/items'
import { CursorStore } from './stores/CursorStore'
import { IndexStore } from './stores/IndexStore'
import { AutomergeIndexManager } from './docStore/AutomergeIndexManager'
import { SyncPullQueueManager } from './SyncPullQueueManager'
import { SyncWorkerContext } from './SyncWorkerContext'
import { normalizeItemSnapshot } from './docStore'
import { toAutomergeUrlFromItemId } from './utils/automerge'
import { loadSyncBatch, restoreSyncBatch } from '../shared/VaultPersistence'
import { encodeBytesToBase64, decodeBase64ToBytes } from './utils/base64Utils'
import type { PollOutcome } from './SyncPoller'
import { initTrpcClient } from 'src/api/trpcClient'
import { getTrackedFetch } from 'src/api/trackedFetch'

let globalEventPort: MessagePort | null = null
self.addEventListener('message', ev => {
  if (ev.data && ev.data.type === 'EVENT_PORT') {
    globalEventPort = ev.data.port
  }
})

export class SyncWorker implements SyncApi {
  private _context: SyncWorkerContext | null = null
  private adapter: VaultNetworkAdapter | null = null
  private broker: SyncMessageBroker | null = null
  private clientEventHub = new ClientEventHub()
  private internalEventHub = new WorkerInternalEventHub()
  private isOnline = true
  private syncStatus: SyncStatus = 'idle'
  private unsubscribeRealtimeBus: (() => void) | null = null
  private repoManager: AutomergeRepoManager | null = null
  private subscribedIds = new Set<ItemId>()
  private changeListenersByItemId = new Map<ItemId, () => void>()

  private get context(): SyncWorkerContext {
    if (!this._context) throw new Error("SyncWorker not initialized. Call initRepo first.")
    return this._context
  }

  private updateStatus(status: SyncStatus) {
    if (this.syncStatus === status) return
    this.syncStatus = status
    this.clientEventHub.emit({ type: 'statusChange', status })
  }

  async initRepo(accountId: string, vaultKey: string) {
    this.clearListeners()

    if (this._context) {
      try {
        await this._context.shutdown()
      } catch (err) {
        console.error('[SyncWorker] Error shutting down context in initRepo', err)
      }
      this._context = null
    }

    if (this.broker) {
      try {
        await this.broker.shutdown()
      } catch (err) {
        console.error('[SyncWorker] Error shutting down broker in initRepo', err)
      }
      this.broker = null
    }

    if (this.adapter) {
      try {
        this.adapter.disconnect()
      } catch (err) {
        console.error('[SyncWorker] Error disconnecting adapter in initRepo', err)
      }
      this.adapter = null
    }

    if (this.repoManager) {
      try {
        await this.repoManager.close()
      } catch (err) {
        console.error('[SyncWorker] Error closing RepoManager in initRepo', err)
      }
      this.repoManager = null
    }

    if (this.unsubscribeRealtimeBus) {
      this.unsubscribeRealtimeBus()
      this.unsubscribeRealtimeBus = null
    }

    resetQuotaExceededStatus()
    this.clientEventHub = new ClientEventHub()
    if (globalEventPort) {
      this.clientEventHub.setExternalPort(globalEventPort)
    }
    this.internalEventHub = new WorkerInternalEventHub()
    registerQuotaReporter((msg: string) => {
      this.clientEventHub.emit({ type: 'quotaExceeded', message: msg })
    })

    const trackedFetch = getTrackedFetch(
      () => this.clientEventHub.emit({ type: 'startRequest' }),
      () => this.clientEventHub.emit({ type: 'finishRequest' })
    )
    initTrpcClient(trackedFetch)

    await initWorkerVault(vaultKey)
    await Automerge.initializeWasm(wasmUrl)

    this.adapter = new VaultNetworkAdapter()
    this.repoManager = new AutomergeRepoManager(accountId)
    const repo = this.repoManager.init(this.adapter)

    const cursorStore = new CursorStore(accountId)
    const indexStore = new IndexStore(accountId)
    const indexManager = new AutomergeIndexManager(
      accountId,
      indexStore,
      itemIds => this.clientEventHub.emit({ type: 'indexUpdated', itemIds }),
      metadata => this.clientEventHub.emit({ type: 'metadataUpdated', metadata })
    )
    const pullQueueManager = new SyncPullQueueManager(cursorStore)

    this.broker = new SyncMessageBroker(
      this.adapter,
      this.clientEventHub,
      this.internalEventHub,
      indexManager,
      pullQueueManager
    )

    this._context = new SyncWorkerContext(
      accountId,
      repo,
      this.adapter,
      this.broker,
      this.clientEventHub,
      this.internalEventHub,
      indexStore,
      indexManager,
      cursorStore,
      pullQueueManager,
      items => this.storeItems(items),
      changes => this.mutateMetadata(changes)
    )
    // Listen to client events
    this.clientEventHub.subscribe((event: ClientEvent) => {
      switch (event.type) {
        case 'statusChange':
          this.syncStatus = event.status
          break
        case 'startRequest':
          if (this.isOnline) this.updateStatus('syncing')
          break
        case 'finishRequest':
          if (this.isOnline && this.syncStatus === 'syncing') this.updateStatus('idle')
          break
        case 'indexUpdated': {
          this.scheduleDeletions(event.itemIds)
          this.updateItemSubscriptions(event.itemIds)
          break
        }
      }
    })

    // Listen to worker internal events
    this.internalEventHub.subscribe((event: WorkerInternalEvent) => {
      switch (event.type) {
        case 'pollResult':
          this.handlePollResult(event.outcome)
          break
        case 'snapshotNeeded':
          this.context.snapshotManager.scheduleSnapshotPush(event.cursor)
          break
      }
    })

    await this._context.initialize()

    this._context.orchestrator.setOnlineState(this.isOnline)
    this._context.snapshotManager.onOnlineStateChange(this.isOnline)

    this.adapter.setAccount(accountId)
    await this.broker.setAccount(accountId)

    const localItemIds = await this._context.indexManager.listAutomergeItemIds()
    this.updateItemSubscriptions(localItemIds)
    this.clientEventHub.emit({ type: 'indexUpdated', itemIds: localItemIds })

    this.unsubscribeRealtimeBus = subscribeRealtimeBusSyncPing(itemIds => {
      this.subscribeToItems(itemIds)
    })

    this.clientEventHub.emit({ type: 'ready' })
    this.updateStatus(this.isOnline ? 'idle' : 'offline')
    this._context.deletionQueueManager.startTimer()
  }

  async setOnlineState(isOnline: boolean) {
    this.isOnline = isOnline

    this.context.orchestrator.setOnlineState(isOnline)
    this.context.snapshotManager.onOnlineStateChange(isOnline)

    if (!isOnline) {
      this.updateStatus('offline')
      return
    }

    if (this.syncStatus === 'offline') {
      this.updateStatus('degraded')
      return
    }

    if (this.syncStatus !== 'syncing') {
      this.updateStatus('idle')
    }
  }

  handlePollResult(outcome: PollOutcome) {
    if (!this.isOnline) return

    if (outcome === 'failure') {
      this.updateStatus('degraded')
    } else if (outcome === 'success') {
      if (this.syncStatus !== 'syncing') {
        this.updateStatus('idle')
      }
    } else if (outcome !== 'no-poll') {
      this.updateStatus('offline')
    }
  }

  subscribeToItems(itemIds: ItemId[]) {
    const repo = this.context.repo
    for (const id of itemIds) {
      if (this.subscribedIds.has(id)) continue
      this.subscribedIds.add(id)

      const url = toAutomergeUrlFromItemId(id)
      repo.find(url).then(handle => {
        if (!this.subscribedIds.has(id)) return

        const existingListener = this.changeListenersByItemId.get(id)
        if (existingListener) {
          handle.off('change', existingListener)
        }

        const handleChange = () => {
          try {
            const doc = handle.doc() || null
            const item = normalizeItemSnapshot(id, doc)
            if (item?.deleted) {
              this.context.indexManager.removeAutomergeItemIdsFromIndex([id]).catch(console.error)
            }
            this.clientEventHub.emit({ type: 'itemUpdated', id, item })
          } catch (err) {
            console.error(`[SyncWorker] Error handling Automerge doc change for item ${id}:`, err)
          }
        }
        handle.on('change', handleChange)
        this.changeListenersByItemId.set(id, handleChange)
        handleChange()
      }).catch(console.error)
    }
  }

  updateItemSubscriptions(itemIds: ItemId[]) {
    this.subscribeToItems(itemIds)

    const itemIdsSet = new Set(itemIds)
    for (const subscribedId of Array.from(this.subscribedIds)) {
      if (!itemIdsSet.has(subscribedId)) {
        this.unsubscribe(subscribedId)
      }
    }
  }

  scheduleDeletions(itemIds: ItemId[]) {
    const newItemIdsSet = new Set(itemIds)
    void this.context.deletionQueueManager.handleIndexChange(
      newItemIdsSet,
      this.subscribedIds,
    ).catch(console.error)
  }

  private unsubscribe(itemId: ItemId) {
    this.subscribedIds.delete(itemId)
    const listener = this.changeListenersByItemId.get(itemId)
    this.changeListenersByItemId.delete(itemId)

    if (listener) {
      const url = toAutomergeUrlFromItemId(itemId)
      this.context.repo.find(url).then(handle => {
        handle.off('change', listener)
      }).catch(console.error)
    }
  }

  clearListeners() {
    if (this.changeListenersByItemId.size > 0) {
      for (const id of Array.from(this.subscribedIds)) {
        this.unsubscribe(id)
      }
    }
    this.subscribedIds.clear()
    this.changeListenersByItemId.clear()
  }

  // Sync API Pass-through Delegation
  async bootstrapItems() { await this.context.vaultBootstrapper.bootstrapItems() }
  async mutateItem(id: ItemId, changes: Partial<Item>) { await this.context.itemOperations.mutateItem(id, changes) }
  async createItem(item: Item) { await this.context.itemOperations.createItem(item) }
  async storeItems(items: Item[]) { await this.context.itemOperations.storeItems(items) }
  async mutateMetadata(changes: Partial<AccountMetadata>) { await this.context.itemOperations.mutateMetadata(changes) }
  async exportAllBinaries() { return this.context.backupManager.exportAllBinaries() }
  async restoreFromBinaries(documents: Partial<Record<string, string>>) {
    const restored = await this.context.backupManager.restoreFromBinaries(documents)
    return restored
  }

  async forceSync() { this.context.orchestrator.flush() }
  async pushSnapshots() { return this.context.snapshotManager.pushSnapshots() }
  async retryRecoveryItem(itemId: ItemId) { await this.context.recoveryManager.retryRecoveryItem(itemId) }
  async forceOverwriteRecoveryItem(itemId: ItemId) { await this.context.recoveryManager.forceOverwriteRecoveryItem(itemId) }
  async forceDeleteRecoveryItem(itemId: ItemId) { await this.context.recoveryManager.forceDeleteRecoveryItem(itemId) }
  async dismissRecoveryItem(entryId: string) { await this.context.recoveryManager.dismissRecoveryItem(entryId) }
  async listRecoveryItems() { return this.context.recoveryManager.listRecoveryItems() }
  async updateVaultKey(vaultKey: string) { await initWorkerVault(vaultKey) }
  async reencryptAllItems(onProgress: (done: number, total: number) => void) { await this.context.reencryptionManager.reencryptAllItems(onProgress) }

  async exportSyncState(): Promise<BackupSyncState> {
    const context = this.context
    const cursors = context.broker.exportCursors()
    const pendingSyncRaw = await loadSyncBatch(context.accountId)
    const pendingSync = pendingSyncRaw.map(([itemId, messages]) => [
      itemId,
      messages.map(encodeBytesToBase64)
    ] as [ItemId, string[]])
    const lastModified = context.snapshotManager.exportLastModified()

    return { cursors, pendingSync, lastModified }
  }

  async restoreSyncState(state: Partial<BackupSyncState>) {
    const context = this.context
    if (state.cursors) await context.broker.importCursors(state.cursors)
    if (state.pendingSync) {
      const decodedPendingSync = state.pendingSync.map(([itemId, base64Msgs]) => [
        itemId,
        base64Msgs.map(decodeBase64ToBytes)
      ] as [ItemId, Uint8Array[]])
      await restoreSyncBatch(context.accountId, decodedPendingSync)
    }
    if (state.lastModified) await context.snapshotManager.importLastModified(state.lastModified)
  }

  async shutdown(options?: { clearLocalData?: boolean }) {
    this.clearListeners()

    if (this.unsubscribeRealtimeBus) {
      this.unsubscribeRealtimeBus()
      this.unsubscribeRealtimeBus = null
    }

    if (options?.clearLocalData && this.repoManager) {
      try {
        await this.repoManager.clearLocalData()
      } catch (err) {
        console.error('[SyncWorker] Error clearing Automerge DB', err)
      }
    }

    try {
      if (this._context) {
        await this._context.shutdown(options)
      }
    } catch (err) {
      console.error('[SyncWorker] Error shutting down context', err)
    }
    this._context = null

    if (this.broker) {
      try {
        await this.broker.shutdown()
      } catch (err) {
        console.error('[SyncWorker] Error shutting down broker', err)
      }
      this.broker = null
    }

    if (this.adapter) {
      try {
        this.adapter.disconnect()
      } catch (err) {
        console.error('[SyncWorker] Error disconnecting adapter', err)
      }
      this.adapter = null
    }

    if (this.repoManager) {
      try {
        await this.repoManager.close()
      } catch (err) {
        console.error('[SyncWorker] Error closing RepoManager', err)
      }
      this.repoManager = null
    }

    // Give the browser event loop a moment to finish closing the IndexedDB connection
    if (typeof process === 'undefined' || process.env.NODE_ENV !== 'test') {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }

  async ping() {}
}

Comlink.expose(new SyncWorker())
