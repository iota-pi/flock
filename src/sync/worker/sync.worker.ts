/// <reference lib="webworker" />
import * as Comlink from 'comlink'
import * as Automerge from '@automerge/automerge/slim'
import wasmUrl from '@automerge/automerge/automerge.wasm?url'

import type { DocHandle } from '@automerge/automerge-repo/slim'
import type { SyncApi } from './syncProtocol'
import { ClientEventHub, WorkerInternalEventHub, type ClientEvent, type WorkerInternalEvent } from './SyncEventHub'
import type { Item } from '../../state/items'
import type { AccountMetadata } from '../../state/metadata'
import { subscribeRealtimeBusSyncPing } from '../client/realtimeBus'
import { initWorkerVault } from '../../api/vault'
import { AutomergeRepoManager } from './AutomergeRepoManager'
import { VaultNetworkAdapter } from './VaultEncryptedNetworkAdapter'
import { SyncMessageBroker } from './SyncMessageBroker'
import { SyncStatusManager } from './SyncStatusManager'
import { registerQuotaReporter, resetQuotaExceededStatus } from '../../utils/storageManager'
import { type BackupSyncState } from '../../types/backup'
import { ItemId } from 'src/shared/schemas/items'
import { CursorStore } from './stores/CursorStore'
import { IndexStore } from './stores/IndexStore'
import { AutomergeIndexManager } from './docStore/AutomergeIndexManager'
import { SyncPullQueueManager } from './SyncPullQueueManager'
import { SyncWorkerContext } from './SyncWorkerContext'
import type { WalEntry } from './SyncWriteAheadLog'
import { normalizeItemSnapshot, RepoDoc } from './docStore'
import { toAutomergeUrlFromItemId, toVaultItemIdFromAutomergeId, ACCOUNT_INDEX_DOCUMENT_ID } from './utils/automerge'
import { SyncWriteAheadLog } from './SyncWriteAheadLog'
import type { PollOutcome } from './SyncPoller'
import { initTrpcClient } from 'src/api/trpcClient'
import { getTrackedFetch } from 'src/api/trackedFetch'
import { reencryptAllItems } from './reencryptAllItems'
import { ServiceLifecycleManager } from './ServiceLifecycleManager'

let globalEventPort: MessagePort | null = null
self.addEventListener('message', ev => {
  if (ev.data && ev.data.type === 'EVENT_PORT') {
    globalEventPort = ev.data.port
  }
  if (ev.data && ev.data.type === 'INIT_PING_PORT') {
    const pingPort: MessagePort = ev.data.port
    pingPort.onmessage = event => {
      if (event.data === 'ping') {
        pingPort.postMessage('pong')
      }
    }
    if (typeof pingPort.start === 'function') {
      pingPort.start()
    }
  }
})

export class SyncWorker implements SyncApi {
  private _context: SyncWorkerContext | null = null
  private adapter: VaultNetworkAdapter | null = null
  private broker: SyncMessageBroker | null = null
  private clientEventHub = new ClientEventHub()
  private internalEventHub = new WorkerInternalEventHub()
  private isOnline = true
  private syncStatusManager = new SyncStatusManager(this.clientEventHub)
  private unsubscribeRealtimeBus: (() => void) | null = null
  private repoManager: AutomergeRepoManager | null = null
  private subscribedIds = new Set<ItemId>()
  private changeListenersByItemId = new Map<ItemId, { handle: DocHandle<RepoDoc>; listener: () => void }>()
  private lifecycle = new ServiceLifecycleManager<{ clearLocalData?: boolean }>('SyncWorker')

  private get context(): SyncWorkerContext {
    if (!this._context) throw new Error("SyncWorker not initialized. Call initRepo first.")
    return this._context
  }

  async initRepo(accountId: string, vaultKey: string) {
    this.clearListeners()

    await this.lifecycle.stop()
    this._context = null
    this.broker = null
    this.adapter = null
    this.repoManager = null
    if (this.unsubscribeRealtimeBus) {
      this.unsubscribeRealtimeBus()
      this.unsubscribeRealtimeBus = null
    }
    this.lifecycle.clear()

    resetQuotaExceededStatus()
    this.clientEventHub = new ClientEventHub()
    if (globalEventPort) {
      this.clientEventHub.setExternalPort(globalEventPort)
    }
    this.syncStatusManager = new SyncStatusManager(this.clientEventHub)
    this.internalEventHub = new WorkerInternalEventHub()
    registerQuotaReporter((msg: string) => {
      this.syncStatusManager.setQuotaExceeded(true)
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
    const repo = this.repoManager.init(this.adapter, {
      onKeyVersionMissing: kver => this.clientEventHub.emit({ type: 'keyVersionMissing', kver }),
      onDocumentReceived: docId => {
        const itemId = toVaultItemIdFromAutomergeId(docId)
        if (itemId && (itemId as string) !== ACCOUNT_INDEX_DOCUMENT_ID) {
          this.subscribeToItems([itemId])
        }
      },
      onQuotaError: () => {
        this.clientEventHub.emit({
          type: 'quotaExceeded',
          message: 'Storage quota exceeded. Some changes could not be saved to this device.',
        })
      },
    })

    const cursorStore = new CursorStore(accountId)
    const indexStore = new IndexStore(accountId)
    const wal = new SyncWriteAheadLog(accountId)
    const indexManager = new AutomergeIndexManager(
      accountId,
      indexStore,
      itemIds => this.clientEventHub.emit({ type: 'indexUpdated', itemIds }),
      metadata => this.clientEventHub.emit({ type: 'metadataUpdated', metadata })
    )
    const pullQueueManager = new SyncPullQueueManager(cursorStore)
    pullQueueManager.onRetryingStateChange = isRetrying => {
      this.syncStatusManager.setDegradedPull(isRetrying)
    }
    pullQueueManager.onKeyVersionMissing = kver => {
      this.clientEventHub.emit({ type: 'keyVersionMissing', kver })
    }

    this.broker = new SyncMessageBroker(
      this.adapter,
      this.clientEventHub,
      this.internalEventHub,
      indexManager,
      pullQueueManager,
      wal
    )

    this._context = new SyncWorkerContext({
      accountId,
      repo,
      adapter: this.adapter,
      broker: this.broker,
      clientEventHub: this.clientEventHub,
      internalEventHub: this.internalEventHub,
      indexStore,
      indexManager,
      cursorStore,
      pullQueueManager,
      wal,
      onDocHandleReplaced: (itemId, handle) => this.handleDocHandleReplaced(itemId, handle),
      onItemMessageParsed: itemId => {
        if ((itemId as string) !== ACCOUNT_INDEX_DOCUMENT_ID) {
          this.subscribeToItems([itemId])
        }
      },
    })
    // Listen to client events
    this.clientEventHub.subscribe((event: ClientEvent) => {
      switch (event.type) {
        case 'startRequest':
          this.syncStatusManager.startRequest()
          break
        case 'finishRequest':
          this.syncStatusManager.finishRequest()
          break
        case 'indexUpdated': {
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
        case 'multipleLeadersDetected':
          console.warn('[SyncWorker] Multiple leaders detected. Pausing BroadcastChannel sync to prevent feedback loop.')
          this.repoManager?.pauseBroadcastSync()
          break
        case 'soleLeaderRestored':
          console.info('[SyncWorker] Sole leader restored. Resuming BroadcastChannel sync.')
          this.repoManager?.resumeBroadcastSync()
          break
      }
    })

    this.lifecycle.register({
      name: 'RepoManager',
      onStop: async options => {
        if (options?.clearLocalData && this.repoManager) {
          try {
            await this.repoManager.clearLocalData()
          } catch (err) {
            console.error('[SyncWorker] Error clearing Automerge DB', err)
          }
        }
        await this.repoManager?.close()
      },
    })

    this.lifecycle.register({
      name: 'VaultNetworkAdapter',
      onStop: () => {
        this.adapter?.disconnect()
      },
    })

    this.lifecycle.register({
      name: 'SyncMessageBroker',
      onStop: async () => {
        await this.broker?.shutdown()
      },
    })

    this.lifecycle.register({
      name: 'SyncWorkerContext',
      onStart: async () => {
        await this._context?.initialize()
      },
      onStop: async options => {
        await this._context?.shutdown(options)
      },
    })

    this.lifecycle.register({
      name: 'RealtimeBus',
      onStop: () => {
        if (this.unsubscribeRealtimeBus) {
          this.unsubscribeRealtimeBus()
          this.unsubscribeRealtimeBus = null
        }
      },
    })

    this.lifecycle.register({
      name: 'ChangeListeners',
      onStop: () => {
        this.clearListeners()
      },
    })

    await this.lifecycle.start()

    this._context.orchestrator.setOnlineState(this.isOnline)
    this._context.snapshotManager.onOnlineStateChange(this.isOnline)

    // Broker needs to be initialised before the adapter so that the adapter doesn't attempt sending messages before the broker is ready
    await this.broker.setAccount(accountId)
    this.adapter.setAccount(accountId)

    const localItemIds = await this._context.indexManager.listAutomergeItemIds()
    this.updateItemSubscriptions(localItemIds)
    this.clientEventHub.emit({ type: 'indexUpdated', itemIds: localItemIds })

    this.unsubscribeRealtimeBus = subscribeRealtimeBusSyncPing(itemIds => {
      this.subscribeToItems(itemIds)
      if (this._context) {
        this._context.indexManager.addAutomergeItemIdsToIndex(itemIds).catch(console.error)
        this._context.itemOperations.clearManualRecoveryForItems(itemIds).catch(console.error)
      }
    })

    this.clientEventHub.emit({ type: 'ready' })
    this.syncStatusManager.reset(this.isOnline)
  }

  async setOnlineState(isOnline: boolean) {
    this.isOnline = isOnline

    this.context.orchestrator.setOnlineState(isOnline)
    this.context.snapshotManager.onOnlineStateChange(isOnline)
    this.syncStatusManager.setOnlineState(isOnline)
  }

  handlePollResult(outcome: PollOutcome) {
    this.syncStatusManager.handlePollResult(outcome)
  }

  private bindItemHandle(id: ItemId, handle: DocHandle<RepoDoc>) {
    const existing = this.changeListenersByItemId.get(id)
    if (existing) {
      existing.handle.off('change', existing.listener)
    }

    const handleChange = (isDocChange = false) => {
      try {
        const doc = handle.doc() || null
        const item = normalizeItemSnapshot(id, doc)
        if (item?.deleted) {
          this.context.indexManager.removeAutomergeItemIdsFromIndex([id]).catch(console.error)
          this.unsubscribe(id)
        } else if (item) {
          this.context.indexManager.addAutomergeItemIdsToIndex([id]).catch(console.error)
        }
        if (isDocChange) {
          this.context.snapshotManager.recordInboundChange(id)
        }
        this.clientEventHub.emit({ type: 'itemUpdated', id, item })
      } catch (err) {
        console.error(`[SyncWorker] Error handling Automerge doc change for item ${id}:`, err)
      }
    }
    handle.on('change', () => handleChange(true))
    this.changeListenersByItemId.set(id, { handle, listener: handleChange })
    handleChange(false)
  }

  private handleDocHandleReplaced(itemId: ItemId, handle: DocHandle<RepoDoc>) {
    if (this.subscribedIds.has(itemId) || this.changeListenersByItemId.has(itemId)) {
      this.subscribedIds.add(itemId)
      this.bindItemHandle(itemId, handle)
    }
  }

  subscribeToItems(itemIds: ItemId[]) {
    const repo = this.context.repo
    for (const id of itemIds) {
      if (this.subscribedIds.has(id)) continue
      this.subscribedIds.add(id)

      const url = toAutomergeUrlFromItemId(id)
      repo.find<RepoDoc>(url).then(handle => {
        if (!this.subscribedIds.has(id)) return
        const currentHandle = (repo.handles?.[handle.documentId] as DocHandle<RepoDoc> | undefined) ?? handle
        this.bindItemHandle(id, currentHandle)
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

  private unsubscribe(itemId: ItemId) {
    this.subscribedIds.delete(itemId)
    const sub = this.changeListenersByItemId.get(itemId)
    this.changeListenersByItemId.delete(itemId)

    if (sub) {
      sub.handle.off('change', sub.listener)
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
  async bootstrapItems() { await this.context.manifestSyncManager.sync() }
  async mutateItem(id: ItemId, changes: Partial<Item>) { await this.context.itemOperations.mutateItem(id, changes) }
  async createItem(item: Item) { await this.context.itemOperations.createItem(item) }
  async storeItems(items: Item[]) { await this.context.itemOperations.storeItems(items) }
  async mutateMetadata(changes: Partial<AccountMetadata>, options?: { pushRemote?: boolean }) { await this.context.itemOperations.mutateMetadata(changes, options) }
  async exportAllBinaries() { return this.context.docStore.exportAllBinaries(this.context.indexManager) }
  async restoreFromBinaries(documents: Partial<Record<string, string>>) {
    const restored = await this.context.docStore.restoreFromBinaries(documents, this.context.indexManager)
    return restored
  }

  async flushSync() { this.context.orchestrator.flush() }
  async fullResync() {
    await this.context.manifestSyncManager.sync(true)
    this.context.orchestrator.flush()
  }

  async pushSnapshots() { return this.context.snapshotManager.flushPendingSnapshots() }
  async retrySave() {
    if (!this._context) {
      return { success: false, error: 'Sync worker not initialized' }
    }
    return this._context.retrySave()
  }
  async retryRecoveryItem(itemId: ItemId) {
    await this.context.itemOperations.retryRecoveryItem(itemId)
    this.context.snapshotManager.markItemDirty(itemId)
    void this.context.snapshotManager.flushPendingSnapshots()
  }
  async forceOverwriteRecoveryItem(itemId: ItemId) { await this.context.itemOperations.forceOverwriteRecoveryItem(itemId) }
  async forceDeleteRecoveryItem(itemId: ItemId) { await this.context.itemOperations.forceDeleteRecoveryItem(itemId) }
  async compactItem(itemId: ItemId) {
    await this.context.itemOperations.compactItem(itemId)
    void this.context.snapshotManager.flushPendingSnapshots()
  }
  async dismissRecoveryItem(entryId: string) { await this.context.itemOperations.dismissRecoveryItem(entryId) }
  async listRecoveryItems() { return this.context.itemOperations.listRecoveryItems() }
  async updateVaultKey(vaultKey: string) {
    await initWorkerVault(vaultKey)
    this.context?.pullQueueManager?.onKeyringUpdated()
  }
  async reencryptAllItems(
    onProgress: (done: number, total: number) => void,
    refreshAuthToken?: () => Promise<string | null>
  ) {
    return await reencryptAllItems({
      accountId: this.context.accountId,
      repo: this.context.repo,
      indexManager: this.context.indexManager,
      refreshAuthToken,
    }, onProgress)
  }

  async exportSyncState(): Promise<BackupSyncState> {
    const context = this.context
    const cursors = context.broker.exportCursors()
    const walMap = context.wal ? await context.wal.readAll() : new Map<ItemId, WalEntry[]>()
    const pendingSync: [ItemId, string[]][] = Array.from(walMap.entries()).map(([itemId, entries]) => [
      itemId,
      entries.map((e: WalEntry) => e.data.toBase64()),
    ])
    const lastModified = context.snapshotManager.exportLastModified()

    return { cursors, pendingSync, lastModified }
  }

  async restoreSyncState(state: Partial<BackupSyncState>) {
    const context = this.context
    if (state.cursors) await context.broker.importCursors(state.cursors)
    if (state.pendingSync && context.wal) {
      for (const [itemId, base64Msgs] of state.pendingSync) {
        for (const msg of base64Msgs) {
          await context.wal.append(itemId, Uint8Array.fromBase64(msg))
        }
      }
    }
    if (state.lastModified) await context.snapshotManager.importLastModified(state.lastModified)
  }

  async claimLeader() {
    this.context.claimLeader()
  }

  async shutdown(options?: { clearLocalData?: boolean }) {
    await this.lifecycle.stop(options)
    this._context = null
    this.broker = null
    this.adapter = null
    this.repoManager = null
    if (this.unsubscribeRealtimeBus) {
      this.unsubscribeRealtimeBus()
      this.unsubscribeRealtimeBus = null
    }
    this.clearListeners()
    this.lifecycle.clear()

    // Give the browser event loop a moment to finish closing the IndexedDB connection
    if (typeof process === 'undefined' || process.env.NODE_ENV !== 'test') {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
}

Comlink.expose(new SyncWorker())
