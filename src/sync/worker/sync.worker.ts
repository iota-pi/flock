/// <reference lib="webworker" />
import * as Comlink from 'comlink'
import * as Automerge from '@automerge/automerge/slim'
import wasmUrl from '@automerge/automerge/automerge.wasm?url'

import type { DocHandle } from '@automerge/automerge-repo/slim'
import type { SyncApi } from './syncProtocol'
import { ClientEventHub, WorkerInternalEventHub, type ClientEvent, type WorkerInternalEvent } from './SyncEventHub'
import type { Item } from '../../state/items'
import type { AccountMetadata } from '../../state/metadata'
import { subscribeRealtimeBusSyncPing, teardownRealtimeBus } from './realtimeBus'
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
import { fireAndForget } from '../utils/fireAndForget'
import { createLogger } from '../utils/logger'

const log = createLogger('SyncWorker')

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
  private tokenRefreshPromise: Promise<string | null> | null = null
  private tokenRefreshResolve: ((token: string | null) => void) | null = null
  private tokenRefreshTimeoutId: ReturnType<typeof setTimeout> | null = null
  private latestAuthToken: string | null = null

  constructor() {
    this.initReadyPromise()
  }

  requestAuthTokenRefresh = (): Promise<string | null> => {
    if (this.tokenRefreshPromise) {
      return this.tokenRefreshPromise
    }

    this.tokenRefreshPromise = new Promise<string | null>(resolve => {
      this.tokenRefreshResolve = resolve
      this.tokenRefreshTimeoutId = setTimeout(() => {
        log.warn('Token refresh timed out waiting for main thread')
        this.resolveTokenRefresh(null)
      }, 10000)
    })

    this.clientEventHub.emit({ type: 'tokenRefreshNeeded' })
    return this.tokenRefreshPromise
  }

  private resolveTokenRefresh(token: string | null): void {
    if (this.tokenRefreshTimeoutId !== null) {
      clearTimeout(this.tokenRefreshTimeoutId)
      this.tokenRefreshTimeoutId = null
    }
    const resolve = this.tokenRefreshResolve
    this.tokenRefreshResolve = null
    this.tokenRefreshPromise = null
    if (resolve) {
      resolve(token)
    }
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

  private async withContext<T>(fn: (ctx: SyncWorkerContext) => Promise<T> | T): Promise<T> {
    const context = await this.ensureReady()
    return fn(context)
  }

  private get context(): SyncWorkerContext {
    if (!this._context) throw new Error("SyncWorker not initialized. Call initRepo first.")
    return this._context
  }

  private async teardownSession(): Promise<void> {
    this.resolveTokenRefresh(null)
    const accountId = this._context?.accountId
    this.clearListeners()
    if (this.unsubscribeRealtimeBus) {
      this.unsubscribeRealtimeBus()
      this.unsubscribeRealtimeBus = null
    }
    if (accountId) {
      teardownRealtimeBus(accountId)
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
          log.warn('Multiple leaders detected. Pausing BroadcastChannel sync to prevent feedback loop.')
          this._context?.repoManager.pauseBroadcastSync()
          break
        case 'soleLeaderRestored':
          log.info('Sole leader restored. Resuming BroadcastChannel sync.')
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

  private setupRealtimeBus(accountId: string): void {
    this.unsubscribeRealtimeBus = subscribeRealtimeBusSyncPing(accountId, itemIds => {
      this.subscribeToItems(itemIds)
      if (this._context) {
        fireAndForget(
          this._context.indexManager.addAutomergeItemIdsToIndex(itemIds),
          'SyncWorker:addAutomergeItemIdsToIndex',
        )
        fireAndForget(
          this._context.recoveryManager.unquarantineBatch(itemIds),
          'SyncWorker:unquarantineBatch',
        )
      }
    })
  }

  async initRepo(accountId: string, vaultKey: string, refreshAuthToken?: () => Promise<string | null>) {
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
        refreshAuthToken: refreshAuthToken ?? (() => this.requestAuthTokenRefresh()),
        onDocumentReceived: itemId => this.subscribeToItems([itemId]),
        onDocHandleReplaced: (itemId, handle) => this.handleDocHandleReplaced(itemId, handle),
        onQuotaStatusChange: exceeded => this.syncStatusManager.setQuotaExceeded(exceeded),
      })
      if (this.latestAuthToken) {
        context.apiClient.setToken(this.latestAuthToken)
      }
      this._context = context

      this.subscribeClientEvents()
      this.subscribeInternalEvents()

      await this.initializeAccountSession(context, accountId)
      this.setupRealtimeBus(accountId)

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

  setOnlineState = (isOnline: boolean) => {
    this.isOnline = isOnline
    return this.withContext(ctx => {
      ctx.orchestrator.setOnlineState(isOnline)
      ctx.snapshotManager.onOnlineStateChange(isOnline)
      this.syncStatusManager.setOnlineState(isOnline)
    })
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
          fireAndForget(
            this.context.indexManager.removeAutomergeItemIdsFromIndex([id]),
            'SyncWorker:removeAutomergeItemIdsFromIndex',
          )
          this.unsubscribe(id)
        } else if (item) {
          fireAndForget(
            this.context.indexManager.addAutomergeItemIdsToIndex([id]),
            'SyncWorker:addAutomergeItemIdsToIndex',
          )
        }
        if (isDocChange) {
          this.context.snapshotManager.recordInboundChange(id)
        }
        this.clientEventHub.emit({ type: 'itemUpdated', id, item })
      } catch (err) {
        log.error(`Error handling Automerge doc change for item ${id}:`, err)
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
      fireAndForget(
        repo.find<RepoDoc>(url).then(handle => {
          if (!this.subscribedIds.has(id)) return
          const currentHandle = (repo.handles?.[handle.documentId] as DocHandle<RepoDoc> | undefined) ?? handle
          this.bindItemHandle(id, currentHandle)
        }),
        'SyncWorker:subscribeToItems:find',
      )
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
  bootstrapItems = () =>
    this.withContext(async ctx => {
      await ctx.manifestSyncManager.sync()
    })

  mutateItem = (id: ItemId, changes: Partial<Item>) =>
    this.withContext(ctx => ctx.itemOperations.mutateItem(id, changes))

  createItem = (item: Item) =>
    this.withContext(ctx => ctx.itemOperations.createItem(item))

  storeItems = (items: Item[]) =>
    this.withContext(ctx => ctx.itemOperations.storeItems(items))

  mutateMetadata = (changes: Partial<AccountMetadata>, options?: { pushRemote?: boolean }) =>
    this.withContext(ctx => ctx.itemOperations.mutateMetadata(changes, options))

  exportAllBinaries = () =>
    this.withContext(ctx => ctx.docStore.exportAllBinaries(ctx.indexManager))

  restoreFromBinaries = (documents: Partial<Record<string, string>>) =>
    this.withContext(ctx => ctx.docStore.restoreFromBinaries(documents, ctx.indexManager))

  flushSync = () =>
    this.withContext(ctx => ctx.orchestrator.flush())

  fullResync = () =>
    this.withContext(async ctx => {
      const result = await ctx.manifestSyncManager.sync(true)
      if (result.success) {
        ctx.orchestrator.flush()
      }
      return result.success
    })

  pushSnapshots = () =>
    this.withContext(ctx => ctx.snapshotManager.flushPendingSnapshots())

  retrySave = () =>
    this.withContext(ctx => ctx.retrySave()).catch(() => ({
      success: false,
      error: 'Sync worker not initialized',
    }))

  retryRecoveryItem = (itemId: ItemId) =>
    this.withContext(async ctx => {
      await ctx.recoveryManager.unquarantine(itemId)
      ctx.snapshotManager.markItemDirty(itemId)
      fireAndForget(
        ctx.snapshotManager.flushPendingSnapshots(),
        'SyncWorker:retryRecoveryItem:flushPendingSnapshots',
      )
    })

  forceOverwriteRecoveryItem = (itemId: ItemId) =>
    this.withContext(ctx => ctx.itemOperations.forceOverwriteRecoveryItem(itemId))

  forceDeleteRecoveryItem = (itemId: ItemId) =>
    this.withContext(ctx => ctx.itemOperations.forceDeleteRecoveryItem(itemId))

  compactItem = (itemId: ItemId) =>
    this.withContext(async ctx => {
      await ctx.itemOperations.compactItem(itemId)
      fireAndForget(
        ctx.snapshotManager.flushPendingSnapshots(),
        'SyncWorker:compactItem:flushPendingSnapshots',
      )
    })

  dismissRecoveryItem = (entryId: string) =>
    this.withContext(ctx => ctx.recoveryManager.dismissEntry(entryId))

  listRecoveryItems = () =>
    this.withContext(ctx => ctx.recoveryManager.listRecoveryItems())

  updateVaultKey = async (vaultKey: string) => {
    await initWorkerVault(vaultKey)
    return this.withContext(ctx => {
      ctx.pullQueueManager?.onKeyringUpdated()
    })
  }

  updateAuthToken = async (token: string | null): Promise<void> => {
    this.latestAuthToken = token
    if (this._context) {
      this._context.apiClient.setToken(token)
    }
    this.resolveTokenRefresh(token)
  }

  reencryptAllItems = (
    onProgress?: (done: number, total: number) => void,
    refreshAuthToken?: () => Promise<string | null>
  ) =>
    this.withContext(ctx =>
      ctx.itemReencryptor.reencryptAllItems(
        {
          accountId: ctx.accountId,
          repo: ctx.repo,
          indexManager: ctx.indexManager,
          refreshAuthToken: refreshAuthToken ?? (() => this.requestAuthTokenRefresh()),
          recoveryManager: ctx.recoveryManager,
          apiClient: ctx.apiClient,
          reencryptor: ctx.itemReencryptor,
        },
        (done, total) => {
          if (onProgress) {
            try {
              onProgress(done, total)
            } catch {
              // Ignore
            }
          }
          this.clientEventHub.emit({ type: 'reencryptProgress', done, total })
        }
      )
    )

  exportSyncState = (): Promise<BackupSyncState> =>
    this.withContext(async ctx => {
      const cursors = ctx.pullQueueManager.exportCursors()
      const walMap = ctx.wal ? await ctx.wal.readAll() : new Map<ItemId, WalEntry[]>()
      const pendingSync: [ItemId, string[]][] = Array.from(walMap.entries()).map(([itemId, entries]) => [
        itemId,
        entries.map((e: WalEntry) => e.data.toBase64()),
      ])
      const lastModified = ctx.snapshotManager.exportLastModified()

      return { cursors, pendingSync, lastModified }
    })

  restoreSyncState = (state: Partial<BackupSyncState>) =>
    this.withContext(async ctx => {
      if (state.cursors) await ctx.pullQueueManager.importCursors(state.cursors)
      if (state.pendingSync && ctx.wal) {
        for (const [itemId, base64Msgs] of state.pendingSync) {
          for (const msg of base64Msgs) {
            await ctx.wal.append(itemId, Uint8Array.fromBase64(msg))
          }
        }
      }
      if (state.lastModified) await ctx.snapshotManager.importLastModified(state.lastModified)
    })

  claimLeader = () =>
    this.withContext(ctx => ctx.claimLeader())

  async shutdown(options?: { clearLocalData?: boolean }) {
    this.resolveTokenRefresh(null)
    this.latestAuthToken = null
    this.isShutDown = true
    this.isReady = false
    if (this.readyReject) {
      this.readyReject(new Error("SyncWorker not initialized. Call initRepo first."))
    }
    this.initReadyPromise()

    const accountId = this._context?.accountId
    this.clearListeners()
    if (this.unsubscribeRealtimeBus) {
      this.unsubscribeRealtimeBus()
      this.unsubscribeRealtimeBus = null
    }
    if (accountId) {
      teardownRealtimeBus(accountId)
    } else {
      teardownRealtimeBus()
    }
    await this._context?.shutdown(options)
    this._context = null
  }
}

Comlink.expose(new SyncWorker())
