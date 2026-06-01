/* eslint-disable @typescript-eslint/no-explicit-any */
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
  getAutomergeMetadata,
  withAutomergeDocumentChange,
  withAutomergeMetadataChange,
  removeAutomergeItem,
  getAutomergeItem,
  ACCOUNT_INDEX_DOCUMENT_ID,
  removeAutomergeItemIdsFromIndex,
  addAutomergeItemIdsToIndex,
  clearAutomergeDocStore,
  exportAllBinaries,
  restoreFromBinaries,
  AutomergeIndexDocument,
  normalizeItemSnapshot,
} from '../sync/automergeDocStore'
import { initWorkerVault } from '../api/vault'
import { initAutomergeRepo } from '../sync/automergeRepo'
import { toAutomergeUrlFromItemId } from '../sync/automergeRepoIds'

import { VaultEncryptedNetworkAdapter } from 'src/sync/VaultEncryptedNetworkAdapter'
import { ItemId } from '../shared/itemTypes'
import type { SyncStatus } from 'src/state/syncStore'
import type { ManualRecoveryEntry } from '../sync/manualRecoveryStore'

import { SnapshotManager } from './snapshotManager'
import { RecoveryManager } from './recoveryManager'
import { LegacyBootstrapper } from './legacyBootstrapper'

class SyncWorker implements SyncApi {
  private accountId: string | null = null
  private adapter: VaultEncryptedNetworkAdapter | null = null
  private callbacks: SyncCallbacks | null = null
  private isOnline = true
  private syncStatus: SyncStatus = 'idle'
  private subscribedIds = new Set<string>()
  private repo: Repo | null = null
  private releaseLeadershipLock: (() => void) | null = null
  private changeListenersByItemId = new Map<string, () => void>()

  private snapshotManager: SnapshotManager
  private recoveryManager: RecoveryManager
  private legacyBootstrapper: LegacyBootstrapper

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
      (items) => this.storeItems(items),
      (changes) => this.mutateMetadata(changes),
    )
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
    this.adapter?.setOnlineState(isOnline)

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

    this.accountId = accountId
    await this.snapshotManager.loadLastModified(accountId)
    this.callbacks = callbacks

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
    this.adapter.onSnapshotNeeded = (cursor: number, _requestedAt: number) =>
      this.snapshotManager.scheduleSnapshotPush(cursor)

    this.adapter.onAuthFailure = message => {
      this.updateStatus('offline')
      callbacks.onAuthFailure(message).catch(console.error)
    }
    this.adapter.onPollResult = outcome => {
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
    this.adapter.setOnlineState(this.isOnline)

    // Start background leader election
    void this.acquireLeadership(accountId)

    this.adapter.setAccount(accountId)
    const repo = initAutomergeRepo(accountId, this.adapter)
    this.repo = repo
    await initializeAutomergeDocStore(accountId)
    await this.initIndexDocument()

    await this.callbacks.onReady()
    this.updateStatus(this.isOnline ? 'idle' : 'offline')
  }

  private async getIndexHandle() {
    if (!this.repo) return

    const indexUrl = await toAutomergeUrlFromItemId(ACCOUNT_INDEX_DOCUMENT_ID)
    const indexHandle = await this.repo.find<AutomergeIndexDocument>(indexUrl)
    if (!indexHandle) return
    await indexHandle.whenReady(['ready', 'unavailable'])

    return indexHandle
  }

  private async initIndexDocument() {
    const indexHandle = await this.getIndexHandle()
    if (!indexHandle) return

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

    // Unsubscribe from items that were removed from the index
    const deletedIds = (
      Array.from(this.subscribedIds).filter(id => !newItemIdsSet.has(id))
    )
    for (const deletedId of deletedIds) {
      removeAutomergeItem(this.accountId, deletedId).catch(console.error)
    }

    if (this.callbacks) {
      this.callbacks.onIndexUpdated(newItemIds).catch(console.error)

      const newMetadata = indexDoc.metadata || {}
      this.callbacks.onMetadataUpdated(newMetadata).catch(console.error)
    }

    this.subscribeToItems(newItemIds)
    this.snapshotManager.processIndexChangelog(indexDoc, newItemIds)
  }

  private async acquireLeadership(accountId: string) {
    if (this.releaseLeadershipLock) {
      this.releaseLeadershipLock()
      this.releaseLeadershipLock = null
    }

    this.adapter?.setLeader(false)

    if (typeof navigator === 'undefined' || !navigator.locks) {
      this.adapter?.setLeader(true)
      return
    }

    const lockName = `flock-sync-leader-${accountId}`

    void navigator.locks.request(lockName, async () => {
      this.adapter?.setLeader(true)
      if (this.isOnline && this.syncStatus === 'offline') {
        this.updateStatus('idle')
      }

      return new Promise<void>(resolve => {
        this.releaseLeadershipLock = () => {
          this.adapter?.setLeader(false)
          resolve()
        }
      })
    }).catch(err => {
      console.error('[SyncWorker] Failed to acquire lock, falling back to leader mode', err)
      this.adapter?.setLeader(true)
    })
  }

  async setOnlineState(isOnline: boolean) {
    this.applyOnlineState(isOnline)
  }

  private markDocumentDirty(documentId: string) {
    this.snapshotManager.markDocumentDirty(documentId)
  }

  async bootstrapLegacyItems() {
    await this.legacyBootstrapper.bootstrapLegacyItems()
  }

  private subscribeToItems(itemIds: string[]) {
    if (!this.repo) return

    // Subscribe to new items
    for (const id of itemIds) {
      if (this.subscribedIds.has(id)) continue
      this.subscribedIds.add(id)

      toAutomergeUrlFromItemId(id).then(url => {
        if (!this.subscribedIds.has(id) || !this.repo) return
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
      }).catch(console.error)
    }

    // Unsubscribe from removed items
    for (const subscribedId of Array.from(this.subscribedIds)) {
      if (!itemIds.includes(subscribedId)) {
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
      toAutomergeUrlFromItemId(itemId).then(url => {
        if (!this.repo) return
        this.repo.find(url).then(handle => {
          handle.off('change', listener)
        }).catch(console.error)
      }).catch(console.error)
    }
  }

  async mutateItem(mutationId: string, id: string, changes: Partial<Item>) {
    try {
      const updated = await withAutomergeDocumentChange(this.accountId!, id, doc => {
        for (const [key, value] of Object.entries(changes)) {
          if (value === undefined) delete doc[key]
          else doc[key] = value
        }
      })
      if (updated) {
        this.markDocumentDirty(id)
      }
    } catch (err: any) {
      if (this.callbacks) {
        this.callbacks.onMutationFailed(mutationId, err.message).catch(console.error)
        const trueState = await getAutomergeItem(this.accountId!, id)
        this.callbacks.onItemUpdated(id, trueState).catch(console.error)
      }
    }
  }

  async createItem(item: Item) {
    try {
      const updated = await withAutomergeDocumentChange(this.accountId!, item.id, doc => {
        for (const [key, value] of Object.entries(item)) {
          doc[key] = value
        }
      }, { createIfMissing: true, initialValue: item })
      await addAutomergeItemIdsToIndex(this.accountId!, [item.id])
      if (updated) {
        this.markDocumentDirty(item.id)
      }
    } catch (err: any) {
      this.callbacks?.onMutationFailed('create', err.message).catch(console.error)
    }
  }

  async hardDeleteItems(itemIds: string[]) {
    try {
      await removeAutomergeItemIdsFromIndex(this.accountId!, itemIds)
      for (const id of itemIds) {
        await removeAutomergeItem(this.accountId!, id)
      }
    } catch (err: any) {
      this.callbacks?.onMutationFailed('hardDelete', err.message).catch(console.error)
    }
  }

  async storeItems(items: Item[]) {
    const succeededIds = new Set<string>()
    const failedItems: { item: Item; error: any }[] = []

    for (const item of items) {
      try {
        const updated = await withAutomergeDocumentChange(this.accountId!, item.id, doc => {
          for (const [key, value] of Object.entries(item)) {
            if (value === undefined) delete doc[key]
            else doc[key] = value
          }
        }, { createIfMissing: true, initialValue: item })
        if (updated) {
          this.markDocumentDirty(item.id)
        }
        succeededIds.add(item.id)
      } catch (err: any) {
        failedItems.push({ item, error: err })
      }
    }

    if (failedItems.length > 0) {
      const combinedMessage = failedItems.map(f => `${f.item.id}: ${f.error.message}`).join(', ')
      this.callbacks?.onMutationFailed('store', combinedMessage).catch(console.error)
      for (const { item } of failedItems) {
        const trueState = await getAutomergeItem(this.accountId!, item.id)
        this.callbacks?.onItemUpdated(item.id, trueState).catch(console.error)
      }
    }
  }

  async mutateMetadata(changes: Partial<AccountMetadata>) {
    try {
      const updated = await withAutomergeMetadataChange(this.accountId!, metadataDraft => {
        for (const [key, value] of Object.entries(changes)) {
          metadataDraft[key] = value
        }
      })
      if (updated) {
        this.markDocumentDirty(ACCOUNT_INDEX_DOCUMENT_ID)
      }
    } catch (err: any) {
      this.callbacks?.onMutationFailed('metadata', err.message).catch(console.error)
      this.callbacks?.onMetadataUpdated(await getAutomergeMetadata(this.accountId!)).catch(console.error)
    }
  }

  async clearAutomergeDocStore() {
    this.snapshotManager.clear()
    await clearAutomergeDocStore(this.accountId!)
  }

  async exportAllBinaries() {
    return await exportAllBinaries(this.accountId!)
  }

  async restoreFromBinaries(documents: Partial<Record<string, string>>) {
    return await restoreFromBinaries(this.accountId!, documents)
  }

  async forceSync() {
    try {
      this.adapter?.flush()
    } catch (err) {
      console.error('[SyncWorker] forceSync failed', err)
    }
  }

  async pushSnapshots(): Promise<{ persisted: number; total: number }> {
    return await this.snapshotManager.pushSnapshots()
  }

  async retryRecoveryItem(itemId: string) {
    await this.recoveryManager.retryRecoveryItem(itemId)
  }

  async forceOverwriteRecoveryItem(itemId: string) {
    await this.recoveryManager.forceOverwriteRecoveryItem(itemId)
  }

  async forceDeleteRecoveryItem(itemId: string) {
    await this.recoveryManager.forceDeleteRecoveryItem(itemId)
  }

  async dismissRecoveryItem(entryId: string) {
    await this.recoveryManager.dismissRecoveryItem(entryId)
  }

  async listRecoveryItems(): Promise<ManualRecoveryEntry[]> {
    return await this.recoveryManager.listRecoveryItems()
  }
}

Comlink.expose(new SyncWorker())
