/// <reference lib="webworker" />
import * as Comlink from 'comlink'
import * as Automerge from '@automerge/automerge/slim'

import type { InitRepoOptions, SyncApi } from './syncProtocol'
import type { ReadManualRecoveryOptions } from '../shared/manualRecoveryStore'
import { ClientEventHub, WorkerInternalEventHub, type ClientEvent, type WorkerInternalEvent } from './SyncEventHub'

import type { VaultDoc, VaultMetadata } from '../shared/types'
import { subscribeRealtimeBusSyncPing, teardownRealtimeBus } from './realtimeBus'
import { Keyring } from '../../api/Keyring'
import { clearActiveSessionToken, setActiveSessionToken } from '../shared/workerAuthStore'
import { SyncStatusManager } from './SyncStatusManager'
import { resetQuotaExceededStatus } from '../utils/storageManager'
import type { BackupSyncState } from '../shared/backupSyncState'
import { ItemId } from '@vault/shared'
import { SyncWorkerContext, type SyncSessionConfig } from './SyncWorkerContext'
import { ItemSubscriptions } from './ItemSubscriptions'
import type { WalEntry } from './SyncWriteAheadLog'
import type { RepoDoc } from './docStore'
import { ACCOUNT_INDEX_DOCUMENT_ID } from './utils/automerge'
import type { PollOutcome } from './SyncPoller'
import { configureVaultEndpoint, initVaultTrpcClient } from '../../api/vaultTrpcClient'
import { configureVaultStorageNames, type VaultStorageNames } from '../shared/storageNames'
import { getTrackedFetch } from '../../api/trackedFetch'
import { fireAndForget } from '../utils/fireAndForget'
import { createLogger } from '../utils/logger'
import { AbortError } from '../utils/abort'

const log = createLogger('SyncWorker')

/** Everything the host app supplies to the sync worker (see exposeSyncWorker) */
export interface SyncWorkerConfig extends SyncSessionConfig {
  /** URL of Automerge's wasm binary, as resolved by the app's bundler */
  automergeWasmUrl: string
  /** Vault API base URL */
  endpoint: string
  storageNames: VaultStorageNames
}

const NOT_INITIALIZED_MESSAGE = 'SyncWorker not initialized. Call initRepo first.'

let globalEventPort: MessagePort | null = null

/** Reports an error to the main thread. Returns whether it was sent. */
function forwardWorkerError(errorData: { message: string; stack?: string; name?: string }): boolean {
  if (!globalEventPort) return false
  try {
    globalEventPort.postMessage({
      type: 'workerError',
      error: errorData,
    })
    return true
  } catch (e) {
    log.error('Failed to post workerError to globalEventPort:', e)
    return false
  }
}

function installWorkerListeners(): void {
  self.addEventListener('error', (event: ErrorEvent) => {
    const errorObj = event.error instanceof Error ? event.error : null
    const errorData = {
      message: event.message || errorObj?.message || 'Sync Worker Error',
      stack: errorObj?.stack,
      name: errorObj?.name || 'WorkerError',
    }
    // An uncaught exception leaves the worker running. Left uncancelled, the event also fires on the
    // main thread's Worker, whose health monitor takes it for a crash and terminates the worker
    // without a clean shutdown. Once it has been reported it is cancelled; errors that can't be
    // reported still reach the main thread.
    if (forwardWorkerError(errorData)) {
      event.preventDefault()
    }
  })

  self.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    const reason = event.reason
    const isError = reason instanceof Error
    const errorData = {
      message: isError ? reason.message : String(reason),
      stack: isError ? reason.stack : undefined,
      name: isError ? reason.name : 'UnhandledRejection',
    }
    forwardWorkerError(errorData)
  })

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
}

export class SyncWorker implements SyncApi {
  private _context: SyncWorkerContext | null = null
  private ready = createReady()
  private isReady = false
  private isShutDown = false
  private clientEventHub = new ClientEventHub()
  private internalEventHub = new WorkerInternalEventHub()
  private isOnline = true
  private syncStatusManager = new SyncStatusManager(this.clientEventHub)
  private unsubscribeRealtimeBus: (() => void) | null = null
  private readonly subscriptions = new ItemSubscriptions(
    () => this.context.services.repo,
    (itemId, handle) => this.handleItemChange(itemId, handle.doc() || null),
  )

  private tokenRefresh: PromiseWithResolvers<string | null> | null = null
  private tokenRefreshTimeoutId: ReturnType<typeof setTimeout> | null = null
  private latestAuthToken: string | null = null
  private readonly keyring = new Keyring()
  private readonly automergeWasmUrl: string
  /** The settings every session's context is built with */
  private readonly sessionConfig: SyncSessionConfig

  constructor(config: SyncWorkerConfig) {
    const { automergeWasmUrl, endpoint, storageNames, ...sessionConfig } = config
    this.automergeWasmUrl = automergeWasmUrl
    this.sessionConfig = sessionConfig
  }

  requestAuthTokenRefresh = (): Promise<string | null> => {
    if (this.tokenRefresh) {
      return this.tokenRefresh.promise
    }

    this.tokenRefresh = Promise.withResolvers<string | null>()
    this.tokenRefreshTimeoutId = setTimeout(() => {
      log.warn('Token refresh timed out waiting for main thread')
      this.resolveTokenRefresh(null)
    }, 10000)

    this.clientEventHub.emit({ type: 'tokenRefreshNeeded' })
    return this.tokenRefresh.promise
  }

  private resolveTokenRefresh(token: string | null): void {
    if (this.tokenRefreshTimeoutId !== null) {
      clearTimeout(this.tokenRefreshTimeoutId)
      this.tokenRefreshTimeoutId = null
    }
    const tokenRefresh = this.tokenRefresh
    this.tokenRefresh = null
    tokenRefresh?.resolve(token)
  }

  private async ensureReady(): Promise<SyncWorkerContext> {
    if (this.isShutDown) {
      throw new Error(NOT_INITIALIZED_MESSAGE)
    }
    if (this.isReady && this._context) {
      return this._context
    }
    return this.ready.promise
  }

  private async withContext<T>(fn: (ctx: SyncWorkerContext) => Promise<T> | T): Promise<T> {
    const context = await this.ensureReady()
    return fn(context)
  }

  private get context(): SyncWorkerContext {
    if (!this._context) throw new Error(NOT_INITIALIZED_MESSAGE)
    return this._context
  }

  private async teardownSession(options?: { clearLocalData?: boolean }): Promise<void> {
    this.resolveTokenRefresh(null)
    const accountId = this._context?.accountId
    this.subscriptions.clear()
    if (this.unsubscribeRealtimeBus) {
      this.unsubscribeRealtimeBus()
      this.unsubscribeRealtimeBus = null
    }
    if (accountId) {
      teardownRealtimeBus(accountId)
    }
    await this._context?.shutdown(options)
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
    initVaultTrpcClient(trackedFetch)
  }

  private async initGlobalPrerequisites(vaultKey: string): Promise<void> {
    await this.loadKeyring(vaultKey)
    await Automerge.initializeWasm(this.automergeWasmUrl)
  }

  /** Loads the keyring exported by the main thread */
  private async loadKeyring(vaultKey: string): Promise<void> {
    await this.keyring.load(vaultKey)
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
          this._context?.services.repoManager.pauseBroadcastSync()
          break
        case 'soleLeaderRestored':
          log.info('Sole leader restored. Resuming BroadcastChannel sync.')
          this._context?.services.repoManager.resumeBroadcastSync()
          break
        case 'retryingStateChange':
          this.syncStatusManager.setDegradedPull(event.isRetrying)
          break
        case 'keyVersionMissing':
          this.clientEventHub.emit({ type: 'keyVersionMissing', kver: event.kver })
          break
        case 'docHandleReplaced':
          this.subscriptions.rebind(event.itemId, event.handle)
          break
        case 'itemMessageParsed':
          if ((event.itemId as string) !== ACCOUNT_INDEX_DOCUMENT_ID) {
            this.subscriptions.subscribe([event.itemId])
          }
          break
      }
    })
  }

  private async initializeAccountSession(context: SyncWorkerContext, accountId: string): Promise<void> {
    await context.initialize()
    // A shutdown during initialization has stopped the context, which mustn't be brought back to life
    this.assertNotShutDown()
    const { orchestrator, snapshotManager, broker, adapter, indexManager, accountSettings } = context.services

    orchestrator.setOnlineState(this.isOnline)
    snapshotManager.onOnlineStateChange(this.isOnline)

    // Broker needs to be initialised before the adapter so that the adapter doesn't attempt
    // sending messages before the broker is ready
    await broker.setAccount(accountId)
    this.assertNotShutDown()
    adapter.setAccount(accountId)

    const localItemIds = await indexManager.listAutomergeItemIds()
    this.subscriptions.update(localItemIds)
    this.clientEventHub.emit({
      type: 'indexUpdated',
      itemIds: localItemIds.filter(id => !accountSettings.isSettingsDoc(id)),
    })
  }

  private assertNotShutDown(): void {
    if (this.isShutDown) {
      throw new AbortError('The sync worker was shut down during initialization')
    }
  }

  private setupRealtimeBus(accountId: string): void {
    this.unsubscribeRealtimeBus = subscribeRealtimeBusSyncPing(accountId, itemIds => {
      this.subscriptions.subscribe(itemIds)
      if (this._context) {
        // Pings also name deleted items, which mustn't come back. A deliberate restore reaches this
        // tab as a doc change, which re-indexes the item.
        fireAndForget(
          this._context.services.indexManager.addAutomergeItemIdsToIndex(itemIds, { skipTombstoned: true }),
          'SyncWorker:addAutomergeItemIdsToIndex',
        )
      }
    })
  }

  async initRepo(
    accountId: string,
    vaultKey: string,
    refreshAuthToken?: () => Promise<string | null>,
    options?: InitRepoOptions,
  ) {
    this.isShutDown = false
    if (this.isReady) {
      this.isReady = false
      this.ready = createReady()
    }

    await this.teardownSession()

    try {
      this.initWorkerState()
      if (options?.authToken !== undefined) {
        this.setAuthToken(options.authToken)
      }
      await this.initGlobalPrerequisites(vaultKey)

      const context = new SyncWorkerContext({
        accountId,
        clientEventHub: this.clientEventHub,
        internalEventHub: this.internalEventHub,
        refreshAuthToken: refreshAuthToken ?? (() => this.requestAuthTokenRefresh()),
        onDocumentReceived: itemId => this.subscriptions.subscribe([itemId]),
        onDocHandleReplaced: (itemId, handle) => this.subscriptions.rebind(itemId, handle),
        onIndexUpdated: itemIds => {
          if (this._context === context) this.subscriptions.update(itemIds)
        },
        onQuotaStatusChange: exceeded => this.syncStatusManager.setQuotaExceeded(exceeded),
        ...this.sessionConfig,
        randomDataKeys: options?.randomDataKeys,
        keys: this.keyring,
        localKeys: this.keyring,
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
      this.ready.resolve(context)
    } catch (err) {
      this.isReady = false
      this.ready.reject(err)
      this.ready = createReady()
      throw err
    }
  }

  setOnlineState = (isOnline: boolean) => {
    this.isOnline = isOnline
    return this.withContext(ctx => {
      ctx.services.orchestrator.setOnlineState(isOnline)
      ctx.services.snapshotManager.onOnlineStateChange(isOnline)
      this.syncStatusManager.setOnlineState(isOnline)
    })
  }

  handlePollResult(outcome: PollOutcome) {
    this.syncStatusManager.handlePollResult(outcome)
  }

  /** Sends a subscribed item's state to the app and keeps the index in step with it */
  private handleItemChange(id: ItemId, doc: RepoDoc | null): void {
    const { accountSettings, docStore, indexManager } = this.context.services
    if (accountSettings.isSettingsDoc(id)) {
      accountSettings.handleSettingsDoc(doc)
      return
    }
    const item = docStore.decodeSnapshot(id, doc)
    if (item?.deleted) {
      fireAndForget(
        indexManager.removeAutomergeItemIdsFromIndex([id]),
        'SyncWorker:removeAutomergeItemIdsFromIndex',
      )
      this.subscriptions.unsubscribe(id)
    } else if (item) {
      fireAndForget(
        indexManager.addAutomergeItemIdsToIndex([id]),
        'SyncWorker:addAutomergeItemIdsToIndex',
      )
    }
    this.clientEventHub.emit({ type: 'itemUpdated', id, item })
  }

  // Sync API Pass-through Delegation
  bootstrapItems = () =>
    this.withContext(async ctx => {
      await ctx.services.manifestSyncManager.sync()
    })

  mutateItem = (id: ItemId, changes: Partial<VaultDoc>) =>
    this.withContext(ctx => ctx.services.itemOperations.mutateItem(id, changes))

  createItem = (item: VaultDoc) =>
    this.withContext(ctx => ctx.services.itemOperations.createItem(item))

  storeItems = (items: VaultDoc[]) =>
    this.withContext(ctx => ctx.services.itemOperations.storeItems(items))

  mutateMetadata = (changes: Partial<VaultMetadata>) =>
    this.withContext(ctx => ctx.services.accountSettings.mutate(changes))

  exportAllBinaries = () =>
    this.withContext(ctx => ctx.services.docStore.exportAllBinaries(ctx.services.indexManager))

  restoreFromBinaries = (documents: Partial<Record<string, string>>) =>
    this.withContext(ctx => ctx.services.docStore.restoreFromBinaries(documents, ctx.services.indexManager))

  flushSync = (): Promise<void> =>
    this.withContext(ctx => ctx.services.orchestrator.flush())

  fullResync = () =>
    this.withContext(async ctx => {
      const result = await ctx.services.manifestSyncManager.sync(true)
      if (result.success) {
        ctx.services.orchestrator.flush()
      }
      return result.success
    })

  pushSnapshots = () =>
    this.withContext(ctx => ctx.services.snapshotManager.flushPendingSnapshots())

  retrySave = () =>
    this.withContext(ctx => ctx.retrySave()).catch(() => ({
      success: false,
      error: 'Sync worker not initialized',
    }))

  checkDataVersion = () =>
    this.withContext(ctx => ctx.services.dataVersionTracker.checkStatus())

  replaceFromServer = (itemId: ItemId) =>
    this.withContext(ctx => ctx.replaceFromServer(itemId))

  retryRecoveryItem = (itemId: ItemId) =>
    this.withContext(async ctx => {
      await ctx.services.recoveryManager.unquarantine(itemId)
      ctx.services.snapshotManager.clearOversized(itemId)
      ctx.services.snapshotManager.markItemDirty(itemId)
      fireAndForget(
        ctx.services.snapshotManager.flushPendingSnapshots(),
        'SyncWorker:retryRecoveryItem:flushPendingSnapshots',
      )
    })

  forceOverwriteRecoveryItem = (itemId: ItemId) =>
    this.withContext(ctx => ctx.services.itemOperations.forceOverwriteRecoveryItem(itemId))

  forceDeleteRecoveryItem = (itemId: ItemId) =>
    this.withContext(ctx => ctx.services.itemOperations.forceDeleteRecoveryItem(itemId))

  recreateOversizedItem = (itemId: ItemId): Promise<ItemId> =>
    this.withContext(async ctx => {
      const newItemId = await ctx.services.itemOperations.recreateOversizedItem(itemId)
      // The deleted old item is too large to upload, so it is pushed as a metadata-only tombstone
      ctx.services.snapshotManager.clearOversized(itemId)
      fireAndForget(
        ctx.services.snapshotManager.flushPendingSnapshots(),
        'SyncWorker:recreateOversizedItem:flushPendingSnapshots',
      )
      return newItemId
    })

  dismissRecoveryItem = (entryId: string) =>
    this.withContext(ctx => ctx.services.recoveryManager.dismissEntry(entryId))

  listRecoveryItems = (options?: ReadManualRecoveryOptions) =>
    this.withContext(ctx => ctx.services.recoveryManager.listRecoveryItems(undefined, options))

  updateVaultKey = async (vaultKey: string) => {
    await this.loadKeyring(vaultKey)
    return this.withContext(ctx => {
      ctx.services.pullQueueManager.onKeyringUpdated()
    })
  }

  updateAuthToken = async (token: string | null): Promise<void> => {
    this.setAuthToken(token)
    if (this._context) {
      this._context.apiClient.setToken(token)
    }
    this.resolveTokenRefresh(token)
  }

  /** Holds the session token in memory only, for contexts created later and the API client's fallback */
  private setAuthToken(token: string | null): void {
    this.latestAuthToken = token
    setActiveSessionToken(token)
  }

  reencryptAllItems = (
    onProgress?: (done: number, total: number) => void,
    refreshAuthToken?: () => Promise<string | null>
  ) =>
    this.withContext(async ctx => {
      const { itemReencryptor, repo, indexManager, recoveryManager } = ctx.services
      const result = await itemReencryptor.reencryptAllItems(
        {
          accountId: ctx.accountId,
          repo,
          indexManager,
          refreshAuthToken: refreshAuthToken ?? (() => this.requestAuthTokenRefresh()),
          recoveryManager,
          apiClient: ctx.apiClient,
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
      // After a rotation, the device storage key moves to the new active data key too
      await ctx.rewrapDeviceKey()
      return result
    })

  exportSyncState = (): Promise<BackupSyncState> =>
    this.withContext(async ctx => {
      const { pullQueueManager, wal, snapshotManager } = ctx.services
      const cursors = pullQueueManager.exportCursors()
      const walMap = await wal.readAll()
      const pendingSync: [ItemId, string[]][] = Array.from(walMap.entries()).map(([itemId, entries]) => [
        itemId,
        entries.map((e: WalEntry) => e.data.toBase64()),
      ])
      const lastModified = snapshotManager.exportLastModified()

      return { cursors, pendingSync, lastModified }
    })

  restoreSyncState = (state: Partial<BackupSyncState>) =>
    this.withContext(async ctx => {
      const { pullQueueManager, wal, snapshotManager } = ctx.services
      if (state.cursors) await pullQueueManager.importCursors(state.cursors)
      if (state.pendingSync) {
        for (const [itemId, base64Msgs] of state.pendingSync) {
          for (const msg of base64Msgs) {
            await wal.append(itemId, Uint8Array.fromBase64(msg))
          }
        }
      }
      if (state.lastModified) await snapshotManager.importLastModified(state.lastModified)
    })

  claimLeader = () =>
    this.withContext(ctx => ctx.claimLeader())

  async shutdown(options?: { clearLocalData?: boolean }) {
    this.latestAuthToken = null
    clearActiveSessionToken()
    this.isShutDown = true
    this.isReady = false
    this.ready.reject(new Error(NOT_INITIALIZED_MESSAGE))
    this.ready = createReady()

    if (!this._context) {
      // With no session to name an account, every account's bus is closed
      teardownRealtimeBus()
    }
    await this.teardownSession(options)
  }
}

function createReady(): PromiseWithResolvers<SyncWorkerContext> {
  const ready = Promise.withResolvers<SyncWorkerContext>()
  // Callers that wait on it still see the rejection. Without one, a rejection nobody waits for
  // (a failed initRepo or a shutdown before it) would be reported as an unhandled worker error.
  ready.promise.catch(() => {})
  return ready
}

/**
 * Starts the sync worker. Call this from the app's worker entry file, which lets the app's bundler
 * resolve the Automerge wasm and bundle the app's codec into the worker.
 */
export function exposeSyncWorker(config: SyncWorkerConfig): void {
  configureVaultStorageNames(config.storageNames)
  configureVaultEndpoint(config.endpoint)
  installWorkerListeners()
  Comlink.expose(new SyncWorker(config))
}
