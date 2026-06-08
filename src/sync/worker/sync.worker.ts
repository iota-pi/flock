/// <reference lib="webworker" />
import * as Comlink from 'comlink'
import * as Automerge from '@automerge/automerge/slim'
import wasmUrl from '@automerge/automerge/automerge.wasm?url'

import type { SyncApi } from './syncProtocol'
import { SyncEventHub, type SyncEventListener, type SyncEvent } from './SyncEventHub'
import type { Item } from '../../state/items'
import type { AccountMetadata } from '../../state/metadata'
import { subscribeRealtimeBusSyncPing } from '../client/realtimeBus'
import { initWorkerVault } from '../../api/vault'
import { AutomergeRepoManager } from './automergeRepo'
import { VaultNetworkAdapter } from './VaultEncryptedNetworkAdapter'
import { SyncMessageBroker } from './SyncMessageBroker'
import { useSyncStore, type SyncStatus } from '../../state/syncStore'
import { registerQuotaReporter, resetQuotaExceededStatus } from '../../utils/storageManager'
import { type BackupSyncState } from '../../types/backup'
import { ItemId } from 'src/shared/schemas/items'
import { CursorStore } from './stores/CursorStore'
import { IndexStore } from './stores/IndexStore'
import { AutomergeIndexManager } from './docStore/AutomergeIndexManager'
import { SyncPullQueueManager } from './SyncPullQueueManager'
import { SyncWorkerContext } from './SyncWorkerContext'
import { normalizeItemSnapshot } from './docStore'
import { toAutomergeUrlFromItemId } from './automergeRepoIds'
import { loadSyncBatch, restoreSyncBatch } from '../shared/VaultPersistence'
import { encodeBytesToBase64, decodeBase64ToBytes } from './utils/base64Utils'
import type { PollOutcome } from './SyncPoller'

export class SyncWorker implements SyncApi {
  private context: SyncWorkerContext | null = null
  private adapter: VaultNetworkAdapter | null = null
  private broker: SyncMessageBroker | null = null
  private eventHub = new SyncEventHub()
  private isOnline = true
  private syncStatus: SyncStatus = 'idle'
  private unsubscribeRealtimeBus: (() => void) | null = null
  private repoManager: AutomergeRepoManager | null = null
  private subscribedIds = new Set<ItemId>()
  private changeListenersByItemId = new Map<ItemId, () => void>()

  private get contextOrThrow(): SyncWorkerContext {
    if (!this.context) throw new Error("SyncWorker not initialized. Call initRepo first.")
    return this.context
  }

  private updateStatus(status: SyncStatus) {
    if (this.syncStatus === status) return
    this.syncStatus = status
    this.eventHub.emit({ type: 'statusChange', status })
  }

  async initRepo(accountId: string, vaultKey: string, onEvent: SyncEventListener) {
    this.clearListeners()

    if (this.context) {
      await this.context.shutdown()
      this.context = null
    }

    if (this.unsubscribeRealtimeBus) {
      this.unsubscribeRealtimeBus()
      this.unsubscribeRealtimeBus = null
    }

    resetQuotaExceededStatus()
    this.eventHub.setExternalListener(onEvent)
    registerQuotaReporter((msg: string) => {
      this.eventHub.emit({ type: 'quotaExceeded', message: msg })
    })

    await initWorkerVault(vaultKey)
    await Automerge.initializeWasm(wasmUrl)

    this.adapter = new VaultNetworkAdapter()
    this.repoManager = new AutomergeRepoManager(accountId)
    const repo = this.repoManager.init(this.adapter)

    const cursorStore = new CursorStore(accountId)
    const indexStore = new IndexStore(accountId)
    const indexManager = new AutomergeIndexManager(accountId, indexStore)
    const pullQueueManager = new SyncPullQueueManager(cursorStore)

    this.broker = new SyncMessageBroker(
      this.adapter,
      this.eventHub,
      indexManager,
      pullQueueManager
    )

    this.context = new SyncWorkerContext(
      accountId,
      repo,
      this.adapter,
      this.broker,
      this.eventHub,
      indexStore,
      indexManager,
      items => this.storeItems(items),
      changes => this.mutateMetadata(changes)
    )
    await this.context.initialize()

    this.context.orchestrator.setOnlineState(this.isOnline)
    this.context.snapshotManager.onOnlineStateChange(this.isOnline)

    // Listen to local events
    this.eventHub.subscribe((event: SyncEvent) => {
      if (!this.context) return
      switch (event.type) {
        case 'statusChange':
          this.syncStatus = event.status
          break
        case 'pollResult':
          this.handlePollResult(event.outcome)
          break
        case 'snapshotNeeded':
          this.context.snapshotManager.scheduleSnapshotPush(event.cursor)
          break
        case 'startRequest':
          if (this.isOnline) this.updateStatus('syncing')
          break
        case 'finishRequest':
          if (this.isOnline && this.syncStatus === 'syncing') this.updateStatus('idle')
          break
        case 'indexUpdated': {
          this.scheduleDeletions(event.itemIds)
          this.subscribeToItems(event.itemIds)
          break
        }
      }
    })

    this.adapter.setAccount(accountId)
    await this.broker.setAccount(accountId)

    const localItemIds = await this.context.indexManager.listAutomergeItemIds()
    this.subscribeToItems(localItemIds)
    this.eventHub.emit({ type: 'indexUpdated', itemIds: localItemIds })

    this.unsubscribeRealtimeBus = subscribeRealtimeBusSyncPing(itemIds => {
      if (!this.context) return
      this.subscribeToItems(itemIds)
    })

    this.eventHub.emit({ type: 'ready' })
    this.updateStatus(this.isOnline ? 'idle' : 'offline')
    this.context.deletionQueueManager.startTimer()
  }

  async setOnlineState(isOnline: boolean) {
    this.isOnline = isOnline
    if (!this.context) return

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
    } else {
      this.updateStatus('offline')
    }
  }

  subscribeToItems(itemIds: ItemId[]) {
    if (!this.context) return
    const repo = this.context.repo
    for (const id of itemIds) {
      if (this.subscribedIds.has(id)) continue
      this.subscribedIds.add(id)

      const url = toAutomergeUrlFromItemId(id)
      repo.find(url).then(handle => {
        if (!this.subscribedIds.has(id)) return

        const handleChange = () => {
          const doc = handle.doc() || null
          const item = normalizeItemSnapshot(id, doc)
          this.eventHub.emit({ type: 'itemUpdated', id, item })
        }
        handle.on('change', handleChange)
        this.changeListenersByItemId.set(id, handleChange)
        handleChange()
      }).catch(console.error)
    }

    const itemIdsSet = new Set(itemIds)
    for (const subscribedId of Array.from(this.subscribedIds)) {
      if (!itemIdsSet.has(subscribedId)) {
        this.unsubscribe(subscribedId)
      }
    }
  }

  scheduleDeletions(itemIds: ItemId[]) {
    if (!this.context) return
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

    if (listener && this.context) {
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
  async bootstrapLegacyItems() { await this.contextOrThrow.legacyBootstrapper.bootstrapLegacyItems() }
  async mutateItem(mutationId: string, id: ItemId, changes: Partial<Item>) { await this.contextOrThrow.itemOperations.mutateItem(mutationId, id, changes) }
  async createItem(item: Item) { await this.contextOrThrow.itemOperations.createItem(item) }
  async hardDeleteItems(itemIds: ItemId[]) { await this.contextOrThrow.itemOperations.hardDeleteItems(itemIds) }
  async storeItems(items: Item[]) { await this.contextOrThrow.itemOperations.storeItems(items) }
  async mutateMetadata(changes: Partial<AccountMetadata>) { await this.contextOrThrow.itemOperations.mutateMetadata(changes) }
  async exportAllBinaries() { return this.contextOrThrow.backupManager.exportAllBinaries() }
  async restoreFromBinaries(documents: Partial<Record<string, string>>) {
    const restored = await this.contextOrThrow.backupManager.restoreFromBinaries(documents)
    useSyncStore.getState().incrementGeneration()
    return restored
  }
  async forceSync() { this.contextOrThrow.orchestrator.flush() }
  async pushSnapshots() { return this.contextOrThrow.snapshotManager.pushSnapshots() }
  async retryRecoveryItem(itemId: ItemId) { await this.contextOrThrow.recoveryManager.retryRecoveryItem(itemId) }
  async forceOverwriteRecoveryItem(itemId: ItemId) { await this.contextOrThrow.recoveryManager.forceOverwriteRecoveryItem(itemId) }
  async forceDeleteRecoveryItem(itemId: ItemId) { await this.contextOrThrow.recoveryManager.forceDeleteRecoveryItem(itemId) }
  async dismissRecoveryItem(entryId: string) { await this.contextOrThrow.recoveryManager.dismissRecoveryItem(entryId) }
  async listRecoveryItems() { return this.contextOrThrow.recoveryManager.listRecoveryItems() }
  async updateVaultKey(vaultKey: string) { await initWorkerVault(vaultKey) }
  async reencryptAllItems(onProgress: (done: number, total: number) => void) { await this.contextOrThrow.reencryptionManager.reencryptAllItems(onProgress) }
  
  async exportSyncState(): Promise<BackupSyncState> {
    const context = this.contextOrThrow
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
    const context = this.contextOrThrow
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

  async shutdown() {
    this.clearListeners()

    if (this.unsubscribeRealtimeBus) {
      this.unsubscribeRealtimeBus()
      this.unsubscribeRealtimeBus = null
    }

    if (this.context) {
      try {
        await this.context.shutdown()
      } catch (err) {
        console.error('[SyncWorker] Error shutting down context', err)
      }
      this.context = null
    }

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
        await this.adapter.disconnect()
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
  }

  async ping() {}
}

Comlink.expose(new SyncWorker())
