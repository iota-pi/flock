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
import { SyncStatusManager } from './SyncStatusManager'
import { resetQuotaExceededStatus } from '../../utils/storageManager'
import { type BackupSyncState } from '../../types/backup'
import { ItemId } from 'src/shared/schemas/items'
import { SyncWorkerContext } from './SyncWorkerContext'
import type { WalEntry } from './SyncWriteAheadLog'
import { normalizeItemSnapshot, RepoDoc } from './docStore'
import { toAutomergeUrlFromItemId, ACCOUNT_INDEX_DOCUMENT_ID } from './utils/automerge'
import type { PollOutcome } from './SyncPoller'
import { initTrpcClient } from 'src/api/trpcClient'
import { getTrackedFetch } from 'src/api/trackedFetch'
import { reencryptAllItems } from './reencryptAllItems'

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
  private readyPromise: Promise<SyncWorkerContext> | null = null
  private readyResolve: ((ctx: SyncWorkerContext) => void) | null = null
  private readyReject: ((err: unknown) => void) | null = null
  private isReady = false
  private isShutDown = false
  private clientEventHub = new ClientEventHub()
  private internalEventHub = new WorkerInternalEventHub()
  private isOnline = true
  private syncStatusManager = new SyncStatusManager(this.clientEventHub)
  private unsubscribeRealtimeBus: (() => void) | null = null
  private subscribedIds = new Set<ItemId>()
  private changeListenersByItemId = new Map<ItemId, { handle: DocHandle<RepoDoc>; listener: () => void }>()

  constructor() {
    this.initReadyPromise()
  }

  private initReadyPromise() {
    this.readyPromise = new Promise<SyncWorkerContext>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
  }

  private async ensureReady(): Promise<SyncWorkerContext> {
    if (this.isShutDown) {
      throw new Error("SyncWorker not initialized. Call initRepo first.")
    }
    if (this.isReady && this._context) {
      return this._context
    }
    if (this.readyPromise) {
      return this.readyPromise
    }
    throw new Error("SyncWorker not initialized. Call initRepo first.")
  }

  private get context(): SyncWorkerContext {
    if (!this._context) throw new Error("SyncWorker not initialized. Call initRepo first.")
    return this._context
  }

  private async teardownSession(): Promise<void> {
    this.clearListeners()
    if (this.unsubscribeRealtimeBus) {
      this.unsubscribeRealtimeBus()
      this.unsubscribeRealtimeBus = null
    }
    await this._context?.shutdown()
    this._context = null
  }

  private initWorkerState(): void {
    resetQuotaExceededStatus()
    this.clientEventHub = new ClientEventHub()
    if (globalEventPort) {
      this.clientEventHub.setExternalPort(globalEventPort)
    }
    this.syncStatusManager = new SyncStatusManager(this.clientEventHub)
    this.internalEventHub = new WorkerInternalEventHub()

    const trackedFetch = getTrackedFetch(
      () => this.clientEventHub.emit({ type: 'startRequest' }),
      () => this.clientEventHub.emit({ type: 'finishRequest' })
    )
    initTrpcClient(trackedFetch)
  }

  private async initGlobalPrerequisites(vaultKey: string): Promise<void> {
    await initWorkerVault(vaultKey)
    await Automerge.initializeWasm(wasmUrl)
  }

  private subscribeClientEvents(): void {
    this.clientEventHub.subscribe((event: ClientEvent) => {
      switch (event.type) {
        case 'startRequest':
          this.syncStatusManager.startRequest()
          break
        case 'finishRequest':
          this.syncStatusManager.finishRequest()
          break
        case 'indexUpdated':
          this.updateItemSubscriptions(event.itemIds)
          break
        case 'quotaExceeded':
          this.syncStatusManager.setQuotaExceeded(true)
          break
        case 'quotaResolved':
          this.syncStatusManager.setQuotaExceeded(false)
          break
      }
    })
  }

  private subscribeInternalEvents(): void {
    this.internalEventHub.subscribe((event: WorkerInternalEvent) => {
      switch (event.type) {
        case 'pollResult':
          this.handlePollResult(event.outcome)
          break
        case 'multipleLeadersDetected':
          console.warn('[SyncWorker] Multiple leaders detected. Pausing BroadcastChannel sync to prevent feedback loop.')
          this._context?.repoManager.pauseBroadcastSync()
          break
        case 'soleLeaderRestored':
          console.info('[SyncWorker] Sole leader restored. Resuming BroadcastChannel sync.')
          this._context?.repoManager.resumeBroadcastSync()
          break
        case 'retryingStateChange':
          this.syncStatusManager.setDegradedPull(event.isRetrying)
          break
        case 'keyVersionMissing':
          this.clientEventHub.emit({ type: 'keyVersionMissing', kver: event.kver })
          break
        case 'docHandleReplaced':
          this.handleDocHandleReplaced(event.itemId, event.handle)
          break
        case 'itemMessageParsed':
          if ((event.itemId as string) !== ACCOUNT_INDEX_DOCUMENT_ID) {
            this.subscribeToItems([event.itemId])
          }
          break
      }
    })
  }

  private async initializeAccountSession(context: SyncWorkerContext, accountId: string): Promise<void> {
    await context.initialize()

    context.orchestrator.setOnlineState(this.isOnline)
    context.snapshotManager.onOnlineStateChange(this.isOnline)

    // Broker needs to be initialised before the adapter so that the adapter doesn't attempt
    // sending messages before the broker is ready
    await context.broker.setAccount(accountId)
    context.adapter.setAccount(accountId)

    const localItemIds = await context.indexManager.listAutomergeItemIds()
    this.updateItemSubscriptions(localItemIds)
    this.clientEventHub.emit({ type: 'indexUpdated', itemIds: localItemIds })
  }

  private setupRealtimeBus(): void {
    this.unsubscribeRealtimeBus = subscribeRealtimeBusSyncPing(itemIds => {
      this.subscribeToItems(itemIds)
      if (this._context) {
        this._context.indexManager.addAutomergeItemIdsToIndex(itemIds).catch(console.error)
        this._context.recoveryManager.unquarantineBatch(itemIds).catch(console.error)
      }
    })
  }

  async initRepo(accountId: string, vaultKey: string) {
    this.isShutDown = false
    if (this.isReady || !this.readyPromise) {
      this.isReady = false
      this.initReadyPromise()
    }

    await this.teardownSession()

    try {
      this.initWorkerState()
      await this.initGlobalPrerequisites(vaultKey)

      const context = new SyncWorkerContext({
        accountId,
        clientEventHub: this.clientEventHub,
        internalEventHub: this.internalEventHub,
        onDocumentReceived: itemId => this.subscribeToItems([itemId]),
        onDocHandleReplaced: (itemId, handle) => this.handleDocHandleReplaced(itemId, handle),
        onQuotaStatusChange: exceeded => this.syncStatusManager.setQuotaExceeded(exceeded),
      })
      this._context = context

      this.subscribeClientEvents()
      this.subscribeInternalEvents()

      await this.initializeAccountSession(context, accountId)
      this.setupRealtimeBus()

      this.clientEventHub.emit({ type: 'ready' })
      this.syncStatusManager.reset(this.isOnline)

      this.isReady = true
      this.readyResolve?.(context)
    } catch (err) {
      this.isReady = false
      this.readyReject?.(err)
      this.initReadyPromise()
      throw err
    }
  }

  async setOnlineState(isOnline: boolean) {
    this.isOnline = isOnline

    const context = await this.ensureReady()
    context.orchestrator.setOnlineState(isOnline)
    context.snapshotManager.onOnlineStateChange(isOnline)
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
  async bootstrapItems() {
    const context = await this.ensureReady()
    await context.manifestSyncManager.sync()
  }

  async mutateItem(id: ItemId, changes: Partial<Item>) {
    const context = await this.ensureReady()
    await context.itemOperations.mutateItem(id, changes)
  }

  async createItem(item: Item) {
    const context = await this.ensureReady()
    await context.itemOperations.createItem(item)
  }

  async storeItems(items: Item[]) {
    const context = await this.ensureReady()
    await context.itemOperations.storeItems(items)
  }

  async mutateMetadata(changes: Partial<AccountMetadata>, options?: { pushRemote?: boolean }) {
    const context = await this.ensureReady()
    await context.itemOperations.mutateMetadata(changes, options)
  }

  async exportAllBinaries() {
    const context = await this.ensureReady()
    return context.docStore.exportAllBinaries(context.indexManager)
  }

  async restoreFromBinaries(documents: Partial<Record<string, string>>) {
    const context = await this.ensureReady()
    const restored = await context.docStore.restoreFromBinaries(documents, context.indexManager)
    return restored
  }

  async flushSync() {
    const context = await this.ensureReady()
    context.orchestrator.flush()
  }

  async fullResync() {
    const context = await this.ensureReady()
    await context.manifestSyncManager.sync(true)
    context.orchestrator.flush()
  }

  async pushSnapshots() {
    const context = await this.ensureReady()
    return context.snapshotManager.flushPendingSnapshots()
  }

  async retrySave() {
    try {
      const context = await this.ensureReady()
      return context.retrySave()
    } catch {
      return { success: false, error: 'Sync worker not initialized' }
    }
  }

  async retryRecoveryItem(itemId: ItemId) {
    const context = await this.ensureReady()
    await context.recoveryManager.unquarantine(itemId)
    context.snapshotManager.markItemDirty(itemId)
    void context.snapshotManager.flushPendingSnapshots()
  }

  async forceOverwriteRecoveryItem(itemId: ItemId) {
    const context = await this.ensureReady()
    await context.itemOperations.forceOverwriteRecoveryItem(itemId)
  }

  async forceDeleteRecoveryItem(itemId: ItemId) {
    const context = await this.ensureReady()
    await context.itemOperations.forceDeleteRecoveryItem(itemId)
  }

  async compactItem(itemId: ItemId) {
    const context = await this.ensureReady()
    await context.itemOperations.compactItem(itemId)
    void context.snapshotManager.flushPendingSnapshots()
  }

  async dismissRecoveryItem(entryId: string) {
    const context = await this.ensureReady()
    await context.recoveryManager.dismissEntry(entryId)
  }

  async listRecoveryItems() {
    const context = await this.ensureReady()
    return context.recoveryManager.listRecoveryItems()
  }

  async updateVaultKey(vaultKey: string) {
    await initWorkerVault(vaultKey)
    const context = await this.ensureReady()
    context.pullQueueManager?.onKeyringUpdated()
  }

  async reencryptAllItems(
    onProgress: (done: number, total: number) => void,
    refreshAuthToken?: () => Promise<string | null>
  ) {
    const context = await this.ensureReady()
    return await reencryptAllItems({
      accountId: context.accountId,
      repo: context.repo,
      indexManager: context.indexManager,
      refreshAuthToken,
      recoveryManager: context.recoveryManager,
    }, onProgress)
  }

  async exportSyncState(): Promise<BackupSyncState> {
    const context = await this.ensureReady()
    const cursors = context.pullQueueManager.exportCursors()
    const walMap = context.wal ? await context.wal.readAll() : new Map<ItemId, WalEntry[]>()
    const pendingSync: [ItemId, string[]][] = Array.from(walMap.entries()).map(([itemId, entries]) => [
      itemId,
      entries.map((e: WalEntry) => e.data.toBase64()),
    ])
    const lastModified = context.snapshotManager.exportLastModified()

    return { cursors, pendingSync, lastModified }
  }

  async restoreSyncState(state: Partial<BackupSyncState>) {
    const context = await this.ensureReady()
    if (state.cursors) await context.pullQueueManager.importCursors(state.cursors)
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
    const context = await this.ensureReady()
    context.claimLeader()
  }

  async shutdown(options?: { clearLocalData?: boolean }) {
    this.isShutDown = true
    this.isReady = false
    if (this.readyReject) {
      this.readyReject(new Error("SyncWorker not initialized. Call initRepo first."))
    }
    this.initReadyPromise()

    this.clearListeners()
    if (this.unsubscribeRealtimeBus) {
      this.unsubscribeRealtimeBus()
      this.unsubscribeRealtimeBus = null
    }
    await this._context?.shutdown(options)
    this._context = null

    // Give the browser event loop a moment to finish closing the IndexedDB connection
    if (typeof process === 'undefined' || process.env.NODE_ENV !== 'test') {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
}

Comlink.expose(new SyncWorker())
