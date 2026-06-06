/// <reference lib="webworker" />
import * as Comlink from 'comlink'
import * as Automerge from '@automerge/automerge/slim'
import wasmUrl from '@automerge/automerge/automerge.wasm?url'
import type { Repo } from '@automerge/automerge-repo/slim'

import type { SyncApi, SyncCallbacks } from './syncProtocol'
import type { Item } from '../state/items'
import type { AccountMetadata } from '../state/metadata'
import {
  initializeAutomergeDocStore,
  ACCOUNT_INDEX_DOCUMENT_ID,
  clearAutomergeDocStore,
  exportAllBinaries,
  restoreFromBinaries,
  AutomergeIndexDocument,
  normalizeItemSnapshot,
} from '../sync/docStore'
import { DeletionQueueManager } from './deletionQueueManager'
import { initWorkerVault } from '../api/vault'
import { initAutomergeRepo } from '../sync/automergeRepo'
import { toAutomergeUrlFromItemId } from '../sync/automergeRepoIds'

import { VaultEncryptedNetworkAdapter } from 'src/sync/VaultEncryptedNetworkAdapter'
import type { SyncStatus } from 'src/state/syncStore'
import type { ManualRecoveryEntry } from '../sync/manualRecoveryStore'

import { SnapshotManager } from './snapshotManager'
import { RecoveryManager } from './recoveryManager'
import { LegacyBootstrapper } from './legacyBootstrapper'
import { ReencryptionManager } from './reencryptionManager'
import { resetQuotaExceededStatus, loadSyncBatch, restoreSyncBatch } from '../sync/VaultPersistence'
import { encodeBytesToBase64, decodeBase64ToBytes } from '../sync/utils/base64Utils'
import { registerQuotaReporter } from '../utils/storageManager'
import type { BackupSyncState } from '../types/backup'
import { SyncOrchestrator } from './SyncOrchestrator'
import { ItemOperations } from './ItemOperations'
import { ItemId } from 'src/shared/schemas/items'


export class SyncWorker implements SyncApi {
  private accountId: string | null = null
  private adapter: VaultEncryptedNetworkAdapter | null = null
  private callbacks: SyncCallbacks | null = null
  private isOnline = true
  private syncStatus: SyncStatus = 'idle'
  private subscribedIds = new Set<ItemId>()
  private repo: Repo | null = null
  private orchestrator: SyncOrchestrator | null = null
  private changeListenersByItemId = new Map<ItemId, () => void>()
  private deletionQueueManager: DeletionQueueManager

  private snapshotManager: SnapshotManager
  private recoveryManager: RecoveryManager
  private legacyBootstrapper: LegacyBootstrapper
  private reencryptionManager: ReencryptionManager
  private itemOperations: ItemOperations

  constructor() {
    this.snapshotManager = new SnapshotManager(() => ({
      accountId: this.accountId,
      repo: this.repo,
      adapter: this.adapter,
    }))

    this.recoveryManager = new RecoveryManager(() => ({
      accountId: this.accountId,
      callbacks: this.callbacks,
    }))

    this.legacyBootstrapper = new LegacyBootstrapper(
      () => ({ accountId: this.accountId }),
      items => this.storeItems(items),
      changes => this.mutateMetadata(changes),
    )

    this.reencryptionManager = new ReencryptionManager(() => ({
      accountId: this.accountId,
      repo: this.repo,
    }))

    this.deletionQueueManager = new DeletionQueueManager(() => ({
      accountId: this.accountId,
      getIndexHandle: () => this.getIndexHandle(),
    }))

    this.itemOperations = new ItemOperations({
      getAccountId: () => this.accountId,
      getCallbacks: () => this.callbacks,
      markDocumentDirty: id => this.markDocumentDirty(id),
      getDeletionQueueManager: () => this.deletionQueueManager,
    })
  }

  private updateStatus(status: SyncStatus) {
    if (this.syncStatus === status) {
      return
    }

    this.syncStatus = status
    this.callbacks?.onStatusChange(status).catch(console.error)
  }

  private applyOnlineState(isOnline: boolean) {
    this.isOnline = isOnline
    this.orchestrator?.setOnlineState(isOnline)
    this.snapshotManager.onOnlineStateChange(isOnline)

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

  async initRepo(accountId: string, vaultKey: string, callbacks: SyncCallbacks) {
    this.clearListeners()
    this.snapshotManager.clear()

    this.deletionQueueManager.stopTimer()

    this.accountId = accountId
    resetQuotaExceededStatus()
    await this.snapshotManager.loadLastModified(accountId)
    this.callbacks = callbacks
    registerQuotaReporter(msg => {
      this.callbacks?.onQuotaExceeded?.(msg).catch(console.error)
    })

    await initWorkerVault(vaultKey)

    // Load Automerge WASM module
    await Automerge.initializeWasm(wasmUrl)

    // Initialise Automerge repo
    this.adapter = new VaultEncryptedNetworkAdapter()
    this.adapter.onStartRequest = () => {
      callbacks.onStartRequest().catch(console.error)
      if (this.isOnline) {
        this.updateStatus('syncing')
      }
    }
    this.adapter.onFinishRequest = () => {
      callbacks.onFinishRequest().catch(console.error)
      if (this.isOnline && this.syncStatus === 'syncing') {
        this.updateStatus('idle')
      }
    }
    this.adapter.onSnapshotNeeded = (cursor: number) => (
      this.snapshotManager.scheduleSnapshotPush(cursor)
    )

    this.orchestrator = new SyncOrchestrator(accountId, this.adapter, {
      onStatusChange: status => {
        this.updateStatus(status)
      },
      onAuthFailure: message => {
        callbacks.onAuthFailure(message).catch(console.error)
      },
      onPollResult: outcome => {
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
    })
    this.orchestrator.setOnlineState(this.isOnline)
    void this.orchestrator.start().catch(console.error)

    await this.adapter.setAccount(accountId)
    const repo = initAutomergeRepo(accountId, this.adapter)
    this.repo = repo
    await initializeAutomergeDocStore(accountId)
    await this.initIndexDocument()

    await this.callbacks.onReady()
    this.updateStatus(this.isOnline ? 'idle' : 'offline')

    this.deletionQueueManager.startTimer()
  }

  private async getIndexHandle() {
    if (!this.repo) return

    const indexUrl = toAutomergeUrlFromItemId(ACCOUNT_INDEX_DOCUMENT_ID)
    const indexHandle = await this.repo.find<AutomergeIndexDocument>(indexUrl)
    if (!indexHandle) return
    await indexHandle.whenReady(['ready', 'unavailable'])

    return indexHandle
  }

  private async initIndexDocument() {
    const indexHandle = await this.getIndexHandle()
    if (!indexHandle) return

    // Ensure we have exactly one change listener on the index document
    indexHandle.off('change')
    indexHandle.on('change', this.handleIndexChange.bind(this))
    this.handleIndexChange()
  }

  private async handleIndexChange() {
    if (!this.accountId) return

    const indexHandle = await this.getIndexHandle()
    if (!indexHandle) return

    const indexDoc = indexHandle.doc()
    if (!indexDoc) return
    const newItemIds = indexDoc.itemIds || []
    const newItemIdsSet = new Set(newItemIds)

    await this.deletionQueueManager.handleIndexChange(newItemIdsSet, this.subscribedIds)

    if (this.callbacks) {
      this.callbacks.onIndexUpdated(newItemIds).catch(console.error)

      const newMetadata = indexDoc.metadata || {}
      this.callbacks.onMetadataUpdated(newMetadata).catch(console.error)
    }

    this.subscribeToItems(newItemIds)
    this.snapshotManager.processIndexChangelog(indexDoc, newItemIds)
  }

  async setOnlineState(isOnline: boolean) {
    this.applyOnlineState(isOnline)
  }

  private markDocumentDirty(itemId: ItemId) {
    this.snapshotManager.markItemDirty(itemId)
  }

  async bootstrapLegacyItems() {
    await this.legacyBootstrapper.bootstrapLegacyItems()
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
          const item = normalizeItemSnapshot(id, handle.doc())
          this.callbacks?.onItemUpdated(id, item).catch(console.error)
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
    await this.itemOperations.mutateItem(mutationId, id, changes)
  }

  async createItem(item: Item) {
    await this.itemOperations.createItem(item)
  }

  async hardDeleteItems(itemIds: ItemId[]) {
    await this.itemOperations.hardDeleteItems(itemIds)
  }

  async storeItems(items: Item[]) {
    await this.itemOperations.storeItems(items)
  }

  async mutateMetadata(changes: Partial<AccountMetadata>) {
    await this.itemOperations.mutateMetadata(changes)
  }

  async exportAllBinaries() {
    return await exportAllBinaries(this.accountId!)
  }

  async restoreFromBinaries(documents: Partial<Record<string, string>>) {
    return await restoreFromBinaries(this.accountId!, documents)
  }

  async forceSync() {
    try {
      this.orchestrator?.flush()
    } catch (err) {
      console.error('[SyncWorker] forceSync failed', err)
    }
  }

  async pushSnapshots(): Promise<{ persisted: number; total: number }> {
    return await this.snapshotManager.pushSnapshots()
  }

  async retryRecoveryItem(itemId: ItemId) {
    await this.recoveryManager.retryRecoveryItem(itemId)
  }

  async forceOverwriteRecoveryItem(itemId: ItemId) {
    await this.recoveryManager.forceOverwriteRecoveryItem(itemId)
  }

  async forceDeleteRecoveryItem(itemId: ItemId) {
    await this.recoveryManager.forceDeleteRecoveryItem(itemId)
  }

  async dismissRecoveryItem(entryId: string) {
    await this.recoveryManager.dismissRecoveryItem(entryId)
  }

  async listRecoveryItems(): Promise<ManualRecoveryEntry[]> {
    return await this.recoveryManager.listRecoveryItems()
  }

  async updateVaultKey(vaultKey: string) {
    await initWorkerVault(vaultKey)
  }

  async reencryptAllItems(onProgress?: (done: number, total: number) => void) {
    await this.reencryptionManager.reencryptAllItems(onProgress)
  }

  async exportSyncState(): Promise<BackupSyncState> {
    const cursors = this.adapter ? this.adapter.exportCursors() : []
    const pendingSyncRaw = this.accountId ? await loadSyncBatch(this.accountId) : []
    const pendingSync = pendingSyncRaw.map(([itemId, messages]) => [
      itemId,
      messages.map(encodeBytesToBase64)
    ] as [ItemId, string[]])
    const lastModified = this.snapshotManager.exportLastModified()

    return {
      cursors,
      pendingSync,
      lastModified,
    }
  }

  async restoreSyncState(state: Partial<BackupSyncState>) {
    if (state.cursors && this.adapter) {
      await this.adapter.importCursors(state.cursors)
    }
    if (state.pendingSync && this.accountId) {
      const decodedPendingSync = state.pendingSync.map(([itemId, base64Msgs]) => [
        itemId,
        base64Msgs.map(decodeBase64ToBytes)
      ] as [ItemId, Uint8Array[]])
      await restoreSyncBatch(this.accountId, decodedPendingSync)
    }
    if (state.lastModified) {
      await this.snapshotManager.importLastModified(state.lastModified)
    }
  }

  async shutdown() {
    if (this.orchestrator) {
      await this.orchestrator.shutdown()
      this.orchestrator = null
    }

    try {
      await this.deletionQueueManager.shutdown()
    } catch (err) {
      console.error('[SyncWorker] Error shutting down DeletionQueueManager', err)
    }

    try {
      await this.snapshotManager.shutdown()
    } catch (err) {
      console.error('[SyncWorker] Error shutting down SnapshotManager', err)
    }

    if (this.adapter) {
      try {
        await this.adapter.disconnect()
      } catch (err) {
        console.error('[SyncWorker] Error disconnecting adapter', err)
      }
      this.adapter = null
    }

    await clearAutomergeDocStore(this.accountId!)

    this.clearListeners()
    this.repo = null
  }

  async ping() {
    // No-op method to verify worker responsiveness
  }
}

Comlink.expose(new SyncWorker())
