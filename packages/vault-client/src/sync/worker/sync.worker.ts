/// <reference lib="webworker" />
import * as Comlink from 'comlink'
import * as Automerge from '@automerge/automerge/slim'

import type { InitRepoOptions, SyncApi } from './syncProtocol'
import type { ReadManualRecoveryOptions } from '../shared/manualRecoveryStore'
import { ClientEventHub, WorkerInternalEventHub, type ClientEvent, type WorkerInternalEvent } from './SyncEventHub'

import type { VaultDoc, VaultMetadata } from '../shared/types'
import { subscribeRealtimeBusSyncPing, teardownRealtimeBus } from './realtimeBus'
import { Keyring } from '../../api/Keyring'
import { setApiAuthToken } from '../../api/runtime'
import { SingleFlightGuard } from '../utils/SingleFlightGuard'
import { SyncStatusManager } from './SyncStatusManager'
import { resetQuotaExceededStatus } from '../utils/storageManager'
import type { BackupSyncState } from '../shared/backupSyncState'
import { ItemId } from '@vault/shared'
import { SyncWorkerContext, type SyncSessionConfig } from './SyncWorkerContext'
import { SyncApiClient } from './SyncApiClient'
import { ItemSubscriptions } from './ItemSubscriptions'
import type { RepoDoc } from './docStore'
import { isIndexDocument } from './utils/automerge'
import { configureVaultEndpoint, initVaultTrpcClient } from '../../api/vaultTrpcClient'
import { configureVaultStorageNames, type VaultStorageNames } from '../shared/storageNames'
import { getTrackedFetch } from '../../api/trackedFetch'
import { fireAndForget } from '../utils/fireAndForget'
import { createLogger } from '../utils/logger'
import { AbortError } from '../utils/abort'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'

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
  private isShutDown = false
  private clientEventHub = new ClientEventHub()
  private internalEventHub = new WorkerInternalEventHub()
  private isOnline = true
  /** Bound to each session's client event hub, so it's created by initWorkerState */
  private syncStatusManager!: SyncStatusManager
  private unsubscribeRealtimeBus: (() => void) | null = null
  private readonly subscriptions = new ItemSubscriptions(
    () => this.context.services.repo,
    (itemId, handle) => this.handleItemChange(itemId, handle.doc() || null),
  )

  private readonly tokenRefresh = new SingleFlightGuard<string | null>()
  /** Settles the refresh in flight with the token the main thread sends (or null) */
  private settleTokenRefresh: ((token: string | null) => void) | null = null
  private readonly keyring = new Keyring()
  private readonly automergeWasmUrl: string
  /** The settings every session's context is built with */
  private readonly sessionConfig: SyncSessionConfig

  constructor(config: SyncWorkerConfig) {
    const { automergeWasmUrl, endpoint, storageNames, ...sessionConfig } = config
    this.automergeWasmUrl = automergeWasmUrl
    this.sessionConfig = sessionConfig
  }

  /**
   * Asks the main thread for a new session token, which arrives through `updateAuthToken`.
   * Concurrent requests share one round trip.
   */
  requestAuthTokenRefresh = (): Promise<string | null> =>
    this.tokenRefresh.run(() => new Promise<string | null>(resolve => {
      const timeoutId = setTimeout(() => {
        log.warn('Token refresh timed out waiting for main thread')
        this.resolveTokenRefresh(null)
      }, SYNC_TIMEOUTS.tokenRefresh)
      this.settleTokenRefresh = token => {
        clearTimeout(timeoutId)
        resolve(token)
      }
      this.clientEventHub.emit({ type: 'tokenRefreshNeeded' })
    }))

  private resolveTokenRefresh(token: string | null): void {
    const settle = this.settleTokenRefresh
    this.settleTokenRefresh = null
    settle?.(token)
  }

  private async ensureReady(): Promise<SyncWorkerContext> {
    if (this.isShutDown) {
      throw new Error(NOT_INITIALIZED_MESSAGE)
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
          this.syncStatusManager.handlePollResult(event.outcome)
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
        case 'docHandleReplaced':
          this.subscriptions.rebind(event.itemId, event.handle)
          break
        case 'itemMessageParsed':
          if (!isIndexDocument(event.itemId)) {
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
    const { broker, adapter, indexManager, accountSettings } = context.services

    this.applyOnlineState(context, this.isOnline)

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
    options?: InitRepoOptions,
  ) {
    this.isShutDown = false
    // Callers already waiting on the previous session wait for this one. Resolving a settled
    // promise does nothing.
    const previous = this.ready
    this.ready = createReady()
    previous.resolve(this.ready.promise)

    await this.teardownSession()

    try {
      this.initWorkerState()
      if (options?.authToken !== undefined) {
        setApiAuthToken(options.authToken || '')
      }
      // The keyring is the one the main thread exported
      await this.keyring.load(vaultKey)
      await Automerge.initializeWasm(this.automergeWasmUrl)

      const context = new SyncWorkerContext({
        accountId,
        clientEventHub: this.clientEventHub,
        internalEventHub: this.internalEventHub,
        apiClient: new SyncApiClient({ refreshAuthToken: () => this.requestAuthTokenRefresh() }),
        onDocumentReceived: itemId => this.subscriptions.subscribe([itemId]),
        onIndexUpdated: itemIds => {
          if (this._context === context) this.subscriptions.update(itemIds)
        },
        ...this.sessionConfig,
        randomDataKeys: options?.randomDataKeys,
        keys: this.keyring,
        localKeys: this.keyring,
      })
      this._context = context

      this.subscribeClientEvents()
      this.subscribeInternalEvents()

      await this.initializeAccountSession(context, accountId)
      this.setupRealtimeBus(accountId)

      this.clientEventHub.emit({ type: 'ready' })
      this.syncStatusManager.reset(this.isOnline)

      this.ready.resolve(context)
    } catch (err) {
      this.ready.reject(err)
      this.ready = createReady()
      throw err
    }
  }

  setOnlineState = (isOnline: boolean) => {
    this.isOnline = isOnline
    return this.withContext(ctx => {
      this.applyOnlineState(ctx, isOnline)
      this.syncStatusManager.setOnlineState(isOnline)
    })
  }

  /** Tells the session's polling and snapshot uploads whether the device is online */
  private applyOnlineState(context: SyncWorkerContext, isOnline: boolean): void {
    context.services.orchestrator.setOnlineState(isOnline)
    context.services.snapshotManager.onOnlineStateChange(isOnline)
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
    this.withContext(ctx => ctx.retryRecoveryItem(itemId))

  forceOverwriteRecoveryItem = (itemId: ItemId) =>
    this.withContext(ctx => ctx.services.itemOperations.forceOverwriteRecoveryItem(itemId))

  forceDeleteRecoveryItem = (itemId: ItemId) =>
    this.withContext(ctx => ctx.services.itemOperations.forceDeleteRecoveryItem(itemId))

  recreateOversizedItem = (itemId: ItemId): Promise<ItemId> =>
    this.withContext(ctx => ctx.recreateOversizedItem(itemId))

  dismissRecoveryItem = (entryId: string) =>
    this.withContext(ctx => ctx.services.recoveryManager.dismissEntry(entryId))

  listRecoveryItems = (options?: ReadManualRecoveryOptions) =>
    this.withContext(ctx => ctx.services.recoveryManager.listRecoveryItems(options))

  updateVaultKey = async (vaultKey: string) => {
    await this.keyring.load(vaultKey)
    return this.withContext(ctx => {
      ctx.services.pullQueueManager.onKeyringUpdated()
    })
  }

  /**
   * Makes `token` the worker's session token, which every request sends. It is kept only in memory:
   * on disk it would outlive the tab, and a copy of the device's storage could make authenticated
   * writes until the session expired.
   */
  updateAuthToken = async (token: string | null): Promise<void> => {
    setApiAuthToken(token || '')
    this.resolveTokenRefresh(token)
  }

  reencryptAllItems = () =>
    this.withContext(async ctx => {
      const result = await ctx.services.itemReencryptor.reencryptAllItems({
        onProgress: (done, total) => {
          this.clientEventHub.emit({ type: 'reencryptProgress', done, total })
        },
      })
      // After a rotation, the device storage key moves to the new active data key too
      await ctx.rewrapDeviceKey()
      return result
    })

  exportSyncState = (): Promise<BackupSyncState> =>
    this.withContext(ctx => ctx.exportSyncState())

  restoreSyncState = (state: Partial<BackupSyncState>) =>
    this.withContext(ctx => ctx.restoreSyncState(state))

  claimLeader = () =>
    this.withContext(ctx => ctx.claimLeader())

  async shutdown(options?: { clearLocalData?: boolean }) {
    setApiAuthToken('')
    this.isShutDown = true
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
