/// <reference lib="webworker" />
import * as Comlink from 'comlink'
import * as Automerge from '@automerge/automerge/slim'
import wasmUrl from '@automerge/automerge/automerge.wasm?url'
import type { Repo } from '@automerge/automerge-repo/slim'

import type { SyncApi } from './syncProtocol'
import { SyncEventHub, type SyncEventListener, type SyncEvent } from './SyncEventHub'
import type { Item } from '../../state/items'
import type { AccountMetadata } from '../../state/metadata'
import {
  AutomergeDocStore,
  normalizeItemSnapshot,
} from './docStore'
import { subscribeRealtimeBusSyncPing } from '../client/realtimeBus'
import { DeletionQueueManager } from './deletionQueueManager'
import { initWorkerVault } from '../../api/vault'
import { AutomergeRepoManager } from './automergeRepo'
import { toAutomergeUrlFromItemId } from './automergeRepoIds'

import { VaultNetworkAdapter } from './VaultEncryptedNetworkAdapter'
import { SyncMessageBroker } from './SyncMessageBroker'
import type { SyncStatus } from '../../state/syncStore'
import type { ManualRecoveryEntry } from '../shared/manualRecoveryStore'
import type { PollOutcome } from './SyncPoller'

import { SnapshotManager } from './snapshotManager'
import { RecoveryManager } from './recoveryManager'
import { LegacyBootstrapper } from './legacyBootstrapper'
import { ReencryptionManager } from './reencryptionManager'
import { loadSyncBatch, restoreSyncBatch } from '../shared/VaultPersistence'
import { encodeBytesToBase64, decodeBase64ToBytes } from './utils/base64Utils'
import { registerQuotaReporter, resetQuotaExceededStatus } from '../../utils/storageManager'
import type { BackupSyncState } from '../../types/backup'
import { SyncOrchestrator } from './SyncOrchestrator'
import { ItemOperations } from './ItemOperations'
import { ItemId } from 'src/shared/schemas/items'

export class SyncWorker implements SyncApi {
  private accountId: string | null = null
  private adapter: VaultNetworkAdapter | null = null
  private broker: SyncMessageBroker | null = null
  private eventHub = new SyncEventHub()
  private isOnline = true
  private syncStatus: SyncStatus = 'idle'
  private subscribedIds = new Set<ItemId>()
  private repo: Repo | null = null
  private orchestrator: SyncOrchestrator | null = null
  private changeListenersByItemId = new Map<ItemId, () => void>()
  private unsubscribeRealtimeBus: (() => void) | null = null

  private repoManager: AutomergeRepoManager | null = null
  private docStore: AutomergeDocStore | null = null

  private snapshotManager: SnapshotManager | null = null
  private recoveryManager: RecoveryManager | null = null
  private legacyBootstrapper: LegacyBootstrapper | null = null
  private reencryptionManager: ReencryptionManager | null = null
  private deletionQueueManager: DeletionQueueManager | null = null
  private itemOperations: ItemOperations | null = null

  constructor() {}

  private updateStatus(status: SyncStatus) {
    if (this.syncStatus === status) {
      return
    }

    this.syncStatus = status
    this.eventHub.emit({ type: 'statusChange', status })
  }

  private applyOnlineState(isOnline: boolean) {
    this.isOnline = isOnline
    this.orchestrator?.setOnlineState(isOnline)
    this.snapshotManager?.onOnlineStateChange(isOnline)

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

  private clearListeners() {
    if (this.repo && this.changeListenersByItemId.size > 0) {
      for (const id of Array.from(this.subscribedIds)) {
        this.unsubscribe(id)
      }
    }
    this.subscribedIds.clear()
    this.changeListenersByItemId.clear()
  }

  async initRepo(accountId: string, vaultKey: string, onEvent: SyncEventListener) {
    this.clearListeners()
    this.snapshotManager?.clear()
    this.deletionQueueManager?.stopTimer()

    this.accountId = accountId
    resetQuotaExceededStatus()

    this.eventHub.setExternalListener(onEvent)
    registerQuotaReporter((msg: string) => {
      this.eventHub.emit({ type: 'quotaExceeded', message: msg })
    })

    await initWorkerVault(vaultKey)

    // Load Automerge WASM module
    await Automerge.initializeWasm(wasmUrl)

    // Initialise Automerge repo
    this.adapter = new VaultNetworkAdapter()
    this.broker = new SyncMessageBroker(this.adapter, this.eventHub, () => this.docStore!)

    this.repoManager = new AutomergeRepoManager(accountId)
    const repo = this.repoManager.init(this.adapter)
    this.repo = repo

    this.docStore = new AutomergeDocStore(accountId, repo)
    await this.docStore.initialize()

    this.snapshotManager = new SnapshotManager({
      accountId,
      repo,
      broker: this.broker,
    })
    await this.snapshotManager.loadLastModified(accountId)

    this.orchestrator = new SyncOrchestrator(accountId, this.broker, this.eventHub)
    this.orchestrator.setOnlineState(this.isOnline)
    void this.orchestrator.start().catch(console.error)

    this.deletionQueueManager = new DeletionQueueManager({
      accountId,
      docStore: this.docStore,
    })

    this.recoveryManager = new RecoveryManager({
      accountId,
      docStore: this.docStore,
    }, this.eventHub)

    this.legacyBootstrapper = new LegacyBootstrapper(
      { accountId, docStore: this.docStore },
      items => this.storeItems(items),
      changes => this.mutateMetadata(changes),
    )

    this.reencryptionManager = new ReencryptionManager({
      accountId,
      repo,
      docStore: this.docStore,
    })

    this.itemOperations = new ItemOperations({
      accountId,
      docStore: this.docStore,
      eventHub: this.eventHub,
      markDocumentDirty: id => this.markDocumentDirty(id),
      deletionQueueManager: this.deletionQueueManager,
    })

    // Listen to local events
    this.eventHub.subscribe((event: SyncEvent) => {
      switch (event.type) {
        case 'statusChange':
          this.syncStatus = event.status
          break
        case 'pollResult':
          this.handlePollResult(event.outcome)
          break
        case 'snapshotNeeded':
          this.snapshotManager?.scheduleSnapshotPush(event.cursor)
          break
        case 'startRequest':
          if (this.isOnline) {
            this.updateStatus('syncing')
          }
          break
        case 'finishRequest':
          if (this.isOnline && this.syncStatus === 'syncing') {
            this.updateStatus('idle')
          }
          break
        case 'indexUpdated': {
          const newItemIdsSet = new Set(event.itemIds)
          this.deletionQueueManager?.handleIndexChange(newItemIdsSet, this.subscribedIds).catch(console.error)
          this.subscribeToItems(event.itemIds)
          break
        }
      }
    })

    this.adapter.setAccount(accountId)
    await this.broker.setAccount(accountId)

    // Load local items index and subscribe
    const localItemIds = await this.docStore.listAutomergeItemIds()
    this.subscribeToItems(localItemIds)
    this.eventHub.emit({ type: 'indexUpdated', itemIds: localItemIds })

    // Listen to tab pings for immediate subscription
    this.unsubscribeRealtimeBus = subscribeRealtimeBusSyncPing(itemIds => {
      if (!this.accountId || !this.repo || !this.docStore) return
      const newIds = itemIds.filter(id => !this.subscribedIds.has(id))
      if (newIds.length > 0) {
        if (this.broker) {
          this.broker.queuePendingPullItems(newIds)
        }
        this.docStore.addAutomergeItemIdsToIndex(newIds).then(async () => {
          const updatedIds = await this.docStore!.listAutomergeItemIds()
          this.eventHub.emit({ type: 'indexUpdated', itemIds: updatedIds })
        }).catch(console.error)
      }
    })

    this.eventHub.emit({ type: 'ready' })
    this.updateStatus(this.isOnline ? 'idle' : 'offline')

    this.deletionQueueManager.startTimer()
  }

  private handlePollResult(outcome: PollOutcome) {
    if (!this.isOnline) {
      return
    }

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

  async setOnlineState(isOnline: boolean) {
    this.applyOnlineState(isOnline)
  }

  private markDocumentDirty(itemId: ItemId) {
    this.snapshotManager?.markItemDirty(itemId)
  }

  async bootstrapLegacyItems() {
    await this.legacyBootstrapper?.bootstrapLegacyItems()
  }

  private subscribeToItems(itemIds: ItemId[]) {
    if (!this.repo) return

    // Subscribe to new items
    for (const id of itemIds) {
      if (this.subscribedIds.has(id)) continue
      this.subscribedIds.add(id)

      const url = toAutomergeUrlFromItemId(id)
      this.repo.find(url).then(handle => {
        if (!this.subscribedIds.has(id)) return

        const handleChange = () => {
          const item = normalizeItemSnapshot(id, handle.doc() || null)
          this.eventHub.emit({ type: 'itemUpdated', id, item })
        }
        handle.on('change', handleChange)
        this.changeListenersByItemId.set(id, handleChange)

        // Trigger an immediate update for the item in case it changed while not subscribed
        handleChange()
      }).catch(console.error)
    }

    // Unsubscribe from removed items
    const itemIdsSet = new Set(itemIds)
    for (const subscribedId of Array.from(this.subscribedIds)) {
      if (!itemIdsSet.has(subscribedId)) {
        this.unsubscribe(subscribedId)
      }
    }
  }

  private unsubscribe(itemId: ItemId) {
    if (!this.repo) return

    this.subscribedIds.delete(itemId)

    const listener = this.changeListenersByItemId.get(itemId)
    this.changeListenersByItemId.delete(itemId)

    if (listener) {
      const url = toAutomergeUrlFromItemId(itemId)
      this.repo.find(url).then(handle => {
        handle.off('change', listener)
      }).catch(console.error)
    }
  }

  async mutateItem(mutationId: string, id: ItemId, changes: Partial<Item>) {
    await this.itemOperations?.mutateItem(mutationId, id, changes)
  }

  async createItem(item: Item) {
    await this.itemOperations?.createItem(item)
  }

  async hardDeleteItems(itemIds: ItemId[]) {
    await this.itemOperations?.hardDeleteItems(itemIds)
  }

  async storeItems(items: Item[]) {
    await this.itemOperations?.storeItems(items)
  }

  async mutateMetadata(changes: Partial<AccountMetadata>) {
    await this.itemOperations?.mutateMetadata(changes)
  }

  async exportAllBinaries() {
    if (!this.docStore) throw new Error('DocStore not initialized')
    return await this.docStore.exportAllBinaries()
  }

  async restoreFromBinaries(documents: Partial<Record<string, string>>) {
    if (!this.docStore) throw new Error('DocStore not initialized')
    return await this.docStore.restoreFromBinaries(documents)
  }

  async forceSync() {
    try {
      this.orchestrator?.flush()
    } catch (err) {
      console.error('[SyncWorker] forceSync failed', err)
    }
  }

  async pushSnapshots(): Promise<{ persisted: number; total: number }> {
    if (!this.snapshotManager) return { persisted: 0, total: 0 }
    return await this.snapshotManager.pushSnapshots()
  }

  async retryRecoveryItem(itemId: ItemId) {
    await this.recoveryManager?.retryRecoveryItem(itemId)
  }

  async forceOverwriteRecoveryItem(itemId: ItemId) {
    await this.recoveryManager?.forceOverwriteRecoveryItem(itemId)
  }

  async forceDeleteRecoveryItem(itemId: ItemId) {
    await this.recoveryManager?.forceDeleteRecoveryItem(itemId)
  }

  async dismissRecoveryItem(entryId: string) {
    await this.recoveryManager?.dismissRecoveryItem(entryId)
  }

  async listRecoveryItems(): Promise<ManualRecoveryEntry[]> {
    if (!this.recoveryManager) return []
    return await this.recoveryManager.listRecoveryItems()
  }

  async updateVaultKey(vaultKey: string) {
    await initWorkerVault(vaultKey)
  }

  async reencryptAllItems(onProgress?: (done: number, total: number) => void) {
    await this.reencryptionManager?.reencryptAllItems(onProgress)
  }

  async exportSyncState(): Promise<BackupSyncState> {
    const cursors = this.broker ? this.broker.exportCursors() : []
    const pendingSyncRaw = this.accountId ? await loadSyncBatch(this.accountId) : []
    const pendingSync = pendingSyncRaw.map(([itemId, messages]) => [
      itemId,
      messages.map(encodeBytesToBase64)
    ] as [ItemId, string[]])
    const lastModified = this.snapshotManager ? this.snapshotManager.exportLastModified() : []

    return {
      cursors,
      pendingSync,
      lastModified,
    }
  }

  async restoreSyncState(state: Partial<BackupSyncState>) {
    if (state.cursors && this.broker) {
      await this.broker.importCursors(state.cursors)
    }
    if (state.pendingSync && this.accountId) {
      const decodedPendingSync = state.pendingSync.map(([itemId, base64Msgs]) => [
        itemId,
        base64Msgs.map(decodeBase64ToBytes)
      ] as [ItemId, Uint8Array[]])
      await restoreSyncBatch(this.accountId, decodedPendingSync)
    }
    if (state.lastModified && this.snapshotManager) {
      await this.snapshotManager.importLastModified(state.lastModified)
    }
  }

  async shutdown() {
    if (this.unsubscribeRealtimeBus) {
      this.unsubscribeRealtimeBus()
      this.unsubscribeRealtimeBus = null
    }

    if (this.orchestrator) {
      await this.orchestrator.shutdown()
      this.orchestrator = null
    }

    if (this.deletionQueueManager) {
      try {
        await this.deletionQueueManager.shutdown()
      } catch (err) {
        console.error('[SyncWorker] Error shutting down DeletionQueueManager', err)
      }
      this.deletionQueueManager = null
    }

    if (this.snapshotManager) {
      try {
        await this.snapshotManager.shutdown()
      } catch (err) {
        console.error('[SyncWorker] Error shutting down SnapshotManager', err)
      }
      this.snapshotManager = null
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

    if (this.docStore) {
      try {
        await this.docStore.clear()
      } catch (err) {
        console.error('[SyncWorker] Error clearing DocStore', err)
      }
      this.docStore = null
    }

    if (this.repoManager) {
      try {
        await this.repoManager.close()
      } catch (err) {
        console.error('[SyncWorker] Error closing RepoManager', err)
      }
      this.repoManager = null
    }

    this.clearListeners()
    this.repo = null
  }

  async ping() {
    // No-op method to verify worker responsiveness
  }
}

Comlink.expose(new SyncWorker())
