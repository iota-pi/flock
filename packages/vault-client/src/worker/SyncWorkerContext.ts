import type { Repo, DocHandle, DocumentId } from '@automerge/automerge-repo/slim'

import { AutomergeDocStore, AutomergeIndexManager } from './docStore'
import type { RepoDoc } from './docStore/AutomergeDocStore'
import { IndexStore } from './stores/IndexStore'
import { LogCursorStore } from './stores/LogCursorStore'
import { SyncLogDatabase } from './stores/SyncLogDatabase'
import { LastModifiedStore } from './stores/LastModifiedStore'
import { SyncedHeadsStore } from './stores/SyncedHeadsStore'
import { SnapshotManager } from './SnapshotManager'
import { SnapshotBuilder } from './SnapshotBuilder'
import { SyncOrchestrator } from './SyncOrchestrator'
import { SyncPoller } from './SyncPoller'
import { ManifestSyncManager } from './ManifestSyncManager'
import { ItemOperations } from './ItemOperations'
import { INBOUND_MESSAGE_RESOLVABLE_KINDS, RecoveryManager } from './RecoveryManager'
import { ChangeOutbox } from './ChangeOutbox'
import { FirstStart, runFirstStartLocalPart } from './FirstStart'
import { GapHealer } from './GapHealer'
import { IncomingChanges } from './IncomingChanges'
import { ServerHeads } from './ServerHeads'
import { SnapshotCoverage } from './SnapshotCoverage'
import { SyncLogPuller } from './SyncLogPuller'
import type { ClientEventHub } from './SyncEventHub'
import { SyncStatusManager } from './SyncStatusManager'
import { SyncProgressTracker } from './SyncProgressTracker'
import { LastSyncedStore } from './stores/LastSyncedStore'
import { AutomergeRepoManager } from './AutomergeRepoManager'
import { toVaultItemIdFromAutomergeId, isIndexDocument } from './utils/automerge'
import type { ItemId } from '@vault/shared'
import { ServiceLifecycleManager, type ServiceRegistration } from './ServiceLifecycleManager'
import type { SyncApiClient } from './SyncApiClient'
import { StorageRecoveryService } from './StorageRecoveryService'
import { ItemRecoveryService } from './ItemRecoveryService'
import { ItemReencryptor } from './ItemReencryptor'
import { SnapshotFormatUpgrade } from './SnapshotFormatUpgrade'
import { DataVersionTracker, MigrationRequiredError, readDeviceDataVersion } from './DataVersionTracker'
import { fireAndForget } from '../utils/fireAndForget'
import { RealtimeBus } from './RealtimeBus'
import { ForegroundTracker } from './ForegroundTracker'
import { SyncSessionState } from './SyncSessionState'
import { DEFAULT_SYNC_DOMAIN, type SyncDomain } from './domain'
import { AccountSettings, withSettingsDocPassthrough } from './AccountSettings'
import { getVaultStorageNames } from '../shared/storageNames'
import { AbortError, untilAborted, withTimeout } from '../utils/abort'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'
import { DSK_KEY, openLocalStorage, type LocalStorage } from './localEncryption/openLocalStorage'
import { LocalCipher, LocalDataUnreadableError, LocalKeyUnavailableError } from './localEncryption/LocalCipher'
import type { KeyProvider, LocalKeyWrapper } from '../keys/Keyring'
import { createLogger } from '../utils/logger'
import type { RetrySaveResult } from './syncProtocol'
import type { UnsyncedChanges } from '../shared/types'

const log = createLogger('SyncWorkerContext')

/** The host app's settings, which every session's context is built with (see SyncWorkerConfig) */
export interface SyncSessionConfig {
  /** The app's document codec and hooks. Defaults to passing documents through untouched. */
  domain?: SyncDomain
  /**
   * Brings the account's local data from older layouts into the current one. Runs once per
   * session before any store is read, one tab at a time. Stores only read the current layout.
   */
  migrateLocalData?: (accountId: string) => Promise<void>
  /**
   * The lowest level of local data this app reads (see `SyncDomain.dataVersion`). Below it, if the
   * device holds any data for the account, sync doesn't start: the worker emits `migrationRequired`
   * and `initRepo` rejects with `MigrationRequiredError`, so the app can send the user to its
   * migration app. Leave it unset in the migration app itself.
   */
  minDataVersion?: number
  /**
   * Whether the device holds the account's data in a layout the app no longer reads. Checked with
   * `minDataVersion` for devices with no data in the current layout.
   */
  hasLegacyLocalData?: (accountId: string) => Promise<boolean>
  /**
   * Rewrites every snapshot once per device, so snapshots from before ciphertexts were bound to
   * their document are replaced (see SnapshotFormatUpgrade). For an app's migration app.
   */
  upgradeSnapshotFormat?: boolean
  /**
   * Fetches the manifest on every sync, rather than at most every `manifestSyncMinGap` on a device that has items, so
   * every row on the server is seen. For an app's migration app.
   */
  fetchManifestEverySync?: boolean
  /**
   * Seals this device's local data with a device storage key, copying any plaintext data into the
   * sealed stores and then deleting the plaintext ones (see docs/local-encryption.md, Part 2)
   */
  upgradeLocalEncryption?: boolean
  /**
   * The app's data version (`SyncDomain.dataVersion`) at which local data is sealed. The device's
   * recorded level stays below it until its storage is sealed and the plaintext stores are retired.
   */
  sealedDataVersion?: number
}

/**
 * Slim configuration for SyncWorkerContext.
 * All stores and managers are constructed internally; only primitive inputs and
 * optional callback bridges back to the Comlink layer are accepted here.
 */
export interface SyncWorkerContextConfig extends SyncSessionConfig {
  accountId: string
  clientEventHub: ClientEventHub
  /** Whether the device is online when the session starts (default true) */
  isOnline?: boolean
  /** Whether this tab is visible when the session starts (default true) */
  isVisible?: boolean
  /**
   * Called when a document arrives from the network, as a new document in the repo or a message
   * pulled for it, so the Comlink layer can subscribe to change events on its handle
   */
  onDocumentReceived?: (itemId: ItemId) => void
  /** Called when the doc store replaces an item's handle, so the Comlink layer can move its listener */
  onDocHandleReplaced?: (itemId: ItemId, handle: DocHandle<RepoDoc>) => void
  /**
   * Called with every indexed document ID, including the settings document, which the
   * `indexUpdated` event sent to the app leaves out.
   */
  onIndexUpdated?: (itemIds: ItemId[]) => void
  /** The client every component calls the server through, so they share its token refresh */
  apiClient: SyncApiClient
  /** Whether the account's data keys are random (see InitRepoOptions) */
  randomDataKeys?: boolean
  /** The account's data keys */
  keys: KeyProvider
  /** Wraps the device storage key. Needed with `upgradeLocalEncryption`. */
  localKeys?: LocalKeyWrapper
}

/** The components `initialize` builds once local storage is open */
export interface SyncWorkerServices {
  realtimeBus: RealtimeBus
  foregroundTracker: ForegroundTracker
  repo: Repo
  repoManager: AutomergeRepoManager
  syncLogDatabase: SyncLogDatabase
  indexStore: IndexStore
  lastModifiedStore: LastModifiedStore
  serverHeads: ServerHeads
  docStore: AutomergeDocStore
  indexManager: AutomergeIndexManager
  recoveryManager: RecoveryManager
  firstStart: FirstStart
  changeOutbox: ChangeOutbox
  snapshotCoverage: SnapshotCoverage
  gapHealer: GapHealer
  puller: SyncLogPuller
  poller: SyncPoller
  snapshotManager: SnapshotManager
  orchestrator: SyncOrchestrator
  manifestSyncManager: ManifestSyncManager
  itemOperations: ItemOperations
  storageRecoveryService: StorageRecoveryService
  itemRecoveryService: ItemRecoveryService
  itemReencryptor: ItemReencryptor
  accountSettings: AccountSettings
  snapshotFormatUpgrade: SnapshotFormatUpgrade | null
  dataVersionTracker: DataVersionTracker
  syncProgress: SyncProgressTracker
}

export class SyncWorkerContext {
  public readonly accountId: string
  public readonly clientEventHub: ClientEventHub
  public readonly apiClient: SyncApiClient
  public readonly domain: SyncDomain
  /** Online, leader and shutdown state, shared by every component of this session */
  public readonly session: SyncSessionState
  /** Works out the sync status the app shows */
  public readonly statusManager: SyncStatusManager
  public readonly lifecycle = new ServiceLifecycleManager<{ clearLocalData?: boolean }>('SyncWorkerContext')
  /** How this session stores local data, once `initialize` has opened it */
  public localStorageState: Pick<LocalStorage, 'mode' | 'retired'> | null = null

  private _services: SyncWorkerServices | null = null
  private unsubscribers: Array<() => void> = []
  private isStopped = false
  private hasLocalDataAtStart = false
  /** Whether this tab is visible, which the foreground tracker starts from */
  private isVisible: boolean
  /** Documents whose sealed records failed to decrypt this session (see AutomergeDocStore.isLocallyUnreadable) */
  private readonly unreadableDocuments = new Set<string>()
  /** The sealed database, whose `meta` store holds the wrapped device storage key */
  private sealedStorage: LocalStorage['storage'] | null = null
  private readonly config: SyncWorkerContextConfig
  /** Asks the main thread to refresh the keyring, for every component that meets an unknown key version */
  private readonly emitKeyVersionMissing = (kver: string): void => {
    this.clientEventHub.emit({ type: 'keyVersionMissing', kver })
  }

  constructor(config: SyncWorkerContextConfig) {
    this.config = config
    this.accountId = config.accountId
    this.clientEventHub = config.clientEventHub
    const domain = config.domain ?? DEFAULT_SYNC_DOMAIN
    this.domain = { ...domain, codec: withSettingsDocPassthrough(domain.codec, config.accountId) }
    this.apiClient = config.apiClient
    this.session = new SyncSessionState({ isOnline: config.isOnline })
    this.isVisible = config.isVisible ?? true
    this.statusManager = new SyncStatusManager(config.clientEventHub, this.session)
  }

  /** The components `initialize` builds. Throws before local storage has been opened. */
  get services(): SyncWorkerServices {
    if (!this._services) {
      throw new Error('SyncWorkerContext has not been initialized')
    }
    return this._services
  }

  /** Creates the Repo and every component that takes it, once local storage is open */
  private createComponents(local: LocalStorage): void {
    this.localStorageState = { mode: local.mode, retired: local.retired }
    this.sealedStorage = local.mode === 'sealed' ? local.storage : null
    const services = this.createServices(local)
    this._services = services
    this.subscribeCrossTabDirtyItems(services)
    this.registerLifecycleServices(services)
  }

  private createServices(local: LocalStorage): SyncWorkerServices {
    const { accountId, keys, clientEventHub } = this.config
    const { session } = this
    const realtimeBus = new RealtimeBus(accountId)
    const foregroundTracker = new ForegroundTracker({
      bus: realtimeBus,
      isVisible: this.isVisible,
      onPeerReturned: () => this._services?.orchestrator.onForeground(),
    })
    const cipherOptions = local.cipher ? { cipher: local.cipher } : undefined
    const indexStore = new IndexStore(accountId, cipherOptions)
    const lastModifiedStore = new LastModifiedStore(accountId)
    const serverHeads = new ServerHeads(new SyncedHeadsStore(accountId))
    const syncLogDatabase = new SyncLogDatabase(accountId)

    const repoManager = new AutomergeRepoManager(accountId, keys, local.storage, {
      bus: realtimeBus,
      onKeyVersionMissing: this.emitKeyVersionMissing,
      onDocumentReceived: docId => this.notifyDocumentReceived(toVaultItemIdFromAutomergeId(docId)),
    })
    const { repo } = repoManager

    // Components created later are read from the finished services
    const docStore = new AutomergeDocStore({
      repo,
      onHandleReplaced: this.config.onDocHandleReplaced,
      storageAdapter: repoManager.storage,
      codec: this.domain.codec,
      isLocallyUnreadable: documentId => this.unreadableDocuments.has(documentId),
      onLocalDataMissing: itemId => this._services?.gapHealer.requestSnapshot(itemId),
    })

    const indexManager = new AutomergeIndexManager({
      accountId,
      indexStore,
      bus: realtimeBus,
      onIndexUpdated: itemIds => {
        this.config.onIndexUpdated?.(itemIds)
        const settingsId = this._services?.accountSettings.docId
        clientEventHub.emit({ type: 'indexUpdated', itemIds: itemIds.filter(id => id !== settingsId) })
      },
      onMetadataUpdated: metadata => this._services?.accountSettings.handleLocalMetadata(metadata),
    })

    const recoveryManager = new RecoveryManager({ accountId, eventHub: clientEventHub })

    const syncProgress = new SyncProgressTracker({
      eventHub: clientEventHub,
      store: new LastSyncedStore(accountId),
      countUnpushedChanges: () => this.countUnpushedChanges(),
    })

    const firstStart = new FirstStart({
      accountId,
      db: syncLogDatabase,
      keys,
      docStore,
      recoveryManager,
      serverHeads,
      syncManifest: signal => this.services.manifestSyncManager.syncNow(signal),
      pushPending: signal => this.services.changeOutbox.pushPending(signal),
      getBaseVersion: itemId => this.services.snapshotManager.tracker.getBaseVersion(itemId),
      isDirty: itemId => this.services.snapshotManager.tracker.isDirty(itemId),
      requestSnapshot: itemId => this.requestUpstreamSnapshot(itemId),
      onManifestSynced: () => this.services.puller.onCatchUpManifestSynced(),
    })

    const changeOutbox = new ChangeOutbox({
      db: syncLogDatabase,
      docStore,
      keys,
      session,
      serverHeads,
      isAwaitingFirstStart: itemId => firstStart.has(itemId),
      canPush: () => firstStart.canPush,
      exchange: (push, onResults, signal) => this.services.poller.exchange(push, onResults, signal),
      requestSnapshot: itemId => this.requestSnapshot([itemId]),
      onMarked: () => {
        this._services?.orchestrator.flush()
        syncProgress.scheduleRecount()
      },
    })

    const snapshotCoverage = new SnapshotCoverage({
      db: syncLogDatabase,
      serverHeads,
      firstStartState: itemId => firstStart.stateOf(itemId),
      isSnapshotOnly: itemId => changeOutbox.isSnapshotOnly(itemId),
      readDocHeads: itemId => docStore.readHeads(itemId),
      requestUpload: itemId => this.requestUpstreamSnapshot(itemId),
    })

    const incoming = new IncomingChanges({
      docStore,
      outbox: changeOutbox,
      serverHeads,
      onItemApplied: itemId => this.notifyDocumentReceived(itemId),
      onChangesAdded: itemId => this.services.puller.onChangesAdded(itemId),
    })

    const gapHealer = new GapHealer({
      db: syncLogDatabase,
      keys,
      docStore,
      incoming,
      recoveryManager,
      fetchSnapshots: (itemIds, signal) => this.services.manifestSyncManager.fetchSnapshots(itemIds, signal),
      onWorkDue: () => this._services?.orchestrator.flush(),
      onKeyVersionMissing: this.emitKeyVersionMissing,
      onHealingChange: isHealing => this.statusManager.setDegradedPull(isHealing),
    })

    const puller = new SyncLogPuller({
      cursorStore: new LogCursorStore(accountId),
      keys,
      session,
      incoming,
      healer: gapHealer,
      coverage: snapshotCoverage,
      bus: realtimeBus,
      onKeyVersionMissing: this.emitKeyVersionMissing,
      onRemoteChangesApplied: itemId => fireAndForget(
        recoveryManager.resolveQuarantines([itemId], INBOUND_MESSAGE_RESOLVABLE_KINDS),
        'SyncWorkerContext:resolveQuarantines',
      ),
      onLoad: async () => {
        await Promise.all([serverHeads.load(), firstStart.load(), snapshotCoverage.load(), gapHealer.load()])
      },
    })

    const poller = new SyncPoller({
      accountId,
      session,
      puller,
      getOutbox: () => changeOutbox,
      firstStart,
      healer: gapHealer,
      apiClient: this.apiClient,
      syncManifest: signal => this.services.manifestSyncManager.syncNow(signal),
    })

    const snapshotBuilder = new SnapshotBuilder(repo, keys, this.domain.codec, snapshotCoverage)

    const pushToLog = (itemIds: ItemId[], signal?: AbortSignal) => changeOutbox.pushItems(itemIds, signal)

    const snapshotManager = new SnapshotManager({
      accountId,
      session,
      lastModifiedStore,
      builder: snapshotBuilder,
      pushToLog,
      onSnapshotStored: details => {
        changeOutbox.confirmSnapshotOnly(details.itemId, details.heads)
        fireAndForget(firstStart.onSnapshotConfirmed(details.itemId, details.heads), 'SyncWorkerContext:onSnapshotConfirmed')
        fireAndForget(snapshotCoverage.onSnapshotStored(details), 'SyncWorkerContext:onSnapshotStored')
      },
      getLatestCursor: () => puller.cursor,
      eventHub: clientEventHub,
      recoveryManager,
      apiClient: this.apiClient,
    })

    const markDocumentDirty = (id: ItemId) => {
      snapshotManager.tracker.markItemDirty(id)
      fireAndForget(changeOutbox.mark(id), 'SyncWorkerContext:markPending')
      // Only the leader pushes and uploads snapshots, so tell it about edits made in this tab
      realtimeBus.publishItemDirty([id])
    }

    const itemOperations = new ItemOperations({
      accountId,
      docStore,
      indexManager,
      eventHub: clientEventHub,
      markDocumentDirty,
      recoveryManager,
      bus: realtimeBus,
      hooks: this.domain.hooks,
      mergedTextFields: this.domain.mergedTextFields,
    })

    const accountSettings = new AccountSettings({
      accountId,
      docStore,
      indexManager,
      eventHub: clientEventHub,
      markDocumentDirty,
      bus: realtimeBus,
      syncedKeys: this.domain.syncedMetadataKeys,
      legacySettings: this.domain.legacySettings,
      withAuth: request => this.apiClient.executeWithAuth(request),
    })

    const itemReencryptor = new ItemReencryptor({
      accountId,
      builder: snapshotBuilder,
      indexManager,
      apiClient: this.apiClient,
      recoveryManager,
      session,
      recorder: snapshotManager,
      claimLeader: () => this.claimLeader(),
      firstStart,
      pushToLog,
    })

    const dataVersionTracker = new DataVersionTracker({
      accountId,
      dataVersion: this.domain.dataVersion ?? 0,
      raiseAccountDataVersion: () => this.apiClient.raiseDataVersion({ account: accountId }),
      maxDeviceVersion: this.maxDeviceVersion(),
    })

    const snapshotFormatUpgrade = this.config.upgradeSnapshotFormat
      ? new SnapshotFormatUpgrade({
        accountId,
        session,
        onUpgraded: () => fireAndForget(
          dataVersionTracker.onSnapshotsUpgraded(),
          'SyncWorkerContext:raiseAccountDataVersion',
        ),
        rewriteSnapshots: signal => itemReencryptor.run({ signal }),
      })
      : null

    const manifestSyncManager = new ManifestSyncManager({
      accountId,
      docStore,
      indexManager,
      snapshotManager,
      keys,
      recoveryManager,
      apiClient: this.apiClient,
      onKeyVersionMissing: this.emitKeyVersionMissing,
      storeItems: (items, options) => itemOperations.storeItems(items, options),
      decodeLegacyItem: this.domain.decodeLegacyItem,
      migrateLegacySettings: () => accountSettings.migrateLegacySettings(),
      onMigrationRequired: () => clientEventHub.emit({ type: 'migrationRequired', reason: 'account' }),
      fetchManifestEverySync: this.config.fetchManifestEverySync,
      onSyncedWithoutFailures: () => {
        snapshotFormatUpgrade?.onSyncedWithoutFailures()
        fireAndForget(dataVersionTracker.onSyncedWithoutFailures(), 'SyncWorkerContext:recordDeviceDataVersion')
      },
      onDecryptionFailure: (itemId, error, serverVersion) => {
        fireAndForget(
          recoveryManager.reportDecryptionFailure(itemId, 'snapshotDecryption', error, { serverVersion }),
          'SyncWorkerContext:reportDecryptionFailure',
        )
      },
      onItemSnapshotHydrated: (itemId, heads) => serverHeads.set(itemId, heads),
      // Server heads may already be past a snapshot the doc holds
      onSnapshotCovered: (itemId, heads) => {
        if (!serverHeads.has(itemId)) serverHeads.set(itemId, heads)
      },
      onLocalChangesFound: itemId => fireAndForget(changeOutbox.mark(itemId), 'SyncWorkerContext:markPending'),
      onManifestProcessed: async manifest => {
        // A follower can run a manifest sync, but the leader owns first start and healing
        if (!session.isLeader) return
        await firstStart.onManifestProcessed(manifest)
        gapHealer.onManifestSynced()
      },
      coverage: snapshotCoverage,
    })

    const orchestrator = new SyncOrchestrator({
      accountId,
      session,
      poller,
      clientEventHub,
      puller,
      manifestSyncManager,
      onLeaderChange: () => {
        // The session already holds the new leadership
        fireAndForget(snapshotManager.onLeaderChange(), 'SyncWorkerContext:leaderChange')
        snapshotFormatUpgrade?.onLeaderChange()
      },
      onLeaderOverlapChange: hasMultipleLeaders => {
        if (hasMultipleLeaders) {
          log.warn('Multiple leaders detected. Pausing BroadcastChannel sync to prevent feedback loop.')
          repoManager.pauseBroadcastSync()
        } else {
          log.info('Sole leader restored. Resuming BroadcastChannel sync.')
          repoManager.resumeBroadcastSync()
        }
      },
      onPollResult: outcome => {
        this.statusManager.handlePollResult(outcome)
        syncProgress.onPollResult(outcome)
      },
      isForeground: () => foregroundTracker.isAnyVisible,
    })

    const storageRecoveryService = new StorageRecoveryService({
      session,
      clientEventHub,
      outbox: changeOutbox,
      docStore,
      snapshotManager,
      lastModifiedStore,
      orchestrator,
    })

    const itemRecoveryService = new ItemRecoveryService({
      repoManager,
      docStore,
      recoveryManager,
      snapshotManager,
      manifestSyncManager,
      itemOperations,
      onLocalCopyDiscarded: documentId => this.unreadableDocuments.delete(documentId),
    })

    return {
      realtimeBus,
      foregroundTracker,
      repo,
      repoManager,
      syncLogDatabase,
      indexStore,
      lastModifiedStore,
      serverHeads,
      docStore,
      indexManager,
      recoveryManager,
      firstStart,
      changeOutbox,
      snapshotCoverage,
      gapHealer,
      puller,
      poller,
      snapshotManager,
      orchestrator,
      manifestSyncManager,
      itemOperations,
      storageRecoveryService,
      itemRecoveryService,
      itemReencryptor,
      accountSettings,
      snapshotFormatUpgrade,
      dataVersionTracker,
      syncProgress,
    }
  }

  /**
   * Caps the recorded device level below the sealed level until this session's storage is sealed and
   * no plaintext stores are left, so a device on the quota fallback or the password-derived-key guard
   * isn't recorded as migrated.
   */
  private maxDeviceVersion(): (() => number) | undefined {
    const sealedDataVersion = this.config.sealedDataVersion
    if (sealedDataVersion === undefined) return undefined
    return () => {
      const state = this.localStorageState
      return state?.mode === 'sealed' && state.retired ? Number.POSITIVE_INFINITY : sealedDataVersion - 1
    }
  }

  private notifyDocumentReceived(itemId: ItemId): void {
    if (itemId && !isIndexDocument(itemId)) {
      this.config.onDocumentReceived?.(itemId)
    }
  }

  private subscribeCrossTabDirtyItems({ realtimeBus, snapshotManager, orchestrator }: SyncWorkerServices): void {
    const unsub = realtimeBus.subscribeItemDirty(itemIds => {
      for (const itemId of itemIds) {
        snapshotManager.tracker.markItemDirty(itemId)
      }
      orchestrator.flush()
    })
    this.unsubscribers.push(unsub)
  }

  private registerLifecycleServices(services: SyncWorkerServices): void {
    const {
      realtimeBus, foregroundTracker, repoManager, syncLogDatabase, storageRecoveryService, indexManager, recoveryManager,
      docStore, snapshotManager, serverHeads, changeOutbox, puller, manifestSyncManager,
      orchestrator, itemReencryptor, snapshotFormatUpgrade, syncProgress,
    } = services

    // Teardown runs in LIFO order (reverse registration order).
    // Startup runs in FIFO order (registration order).
    // Register items that should stop last first, and items that should stop first last.
    //
    // Note: Local storage clearing during account logout is handled exclusively by the
    // main thread (clearAccountLocalData in localDataCleanup.ts) after the worker has cleanly
    // closed all connections. The worker must not attempt to clear databases on shutdown.
    //
    // Each component is stopped here and only here, once. A service with `onStart` is only stopped if
    // that succeeded, so releasing a component that holds work before starting is registered apart.
    const registrations: ServiceRegistration<{ clearLocalData?: boolean }>[] = [
      { name: 'RealtimeBus', onStop: () => realtimeBus.close() },
      {
        name: 'ForegroundTracker',
        onStart: () => foregroundTracker.start(),
        onStop: () => foregroundTracker.stop(),
      },
      // Closed after everything that writes to it, because an open connection blocks a data clear
      { name: 'SyncLogDatabase', onStop: () => syncLogDatabase.close() },
      { name: 'RepoManager', onStop: () => repoManager.close() },
      { name: 'ServerHeads', onStop: options => serverHeads.shutdown(options) },
      {
        name: 'StorageRecoveryService',
        onStart: () => storageRecoveryService.start(),
        onStop: () => storageRecoveryService.stop(),
      },
      { name: 'IndexManager', onStop: () => indexManager.close() },
      { name: 'IndexDocument', onStart: () => indexManager.ensureIndexDocument() },
      { name: 'RecoveryManager', onStop: () => recoveryManager.resetRecoveryState() },
      { name: 'DocStore', onStop: () => docStore.shutdown() },
      // Cross-tab pings can mark items dirty before the timestamps load, so it always stops
      { name: 'SnapshotManager', onStop: options => snapshotManager.shutdown(options) },
      { name: 'LastModifiedTimestamps', onStart: () => snapshotManager.tracker.loadLastModified() },
      { name: 'ChangeOutbox', onStop: () => changeOutbox.shutdown() },
      {
        name: 'SyncLogPuller',
        onStart: () => puller.loadState(),
        onStop: options => puller.shutdown(options),
      },
      { name: 'ManifestSyncManager', onStop: () => manifestSyncManager.shutdown() },
      {
        name: 'SyncOrchestrator',
        onStart: () => orchestrator.start(),
        onStop: () => orchestrator.shutdown(),
      },
      { name: 'ItemReencryptor', onStop: () => itemReencryptor.cancelScheduled() },
      {
        name: 'SyncProgressTracker',
        onStart: () => syncProgress.start(),
        onStop: () => syncProgress.stop(),
      },
    ]
    if (snapshotFormatUpgrade) {
      registrations.push({ name: 'SnapshotFormatUpgrade', onStop: () => snapshotFormatUpgrade.stop() })
    }

    for (const registration of registrations) {
      this.lifecycle.register(registration)
    }
  }

  /** Marks items for a snapshot without debouncing, so their full state is delivered */
  private requestSnapshot(itemIds: ItemId[]): void {
    for (const itemId of itemIds) {
      this._services?.snapshotManager.tracker.markItemDirty(itemId, 0)
    }
  }

  /** Marks an item for a snapshot that catches the server up with this device */
  private requestUpstreamSnapshot(itemId: ItemId): void {
    this._services?.snapshotManager.tracker.markItemDirty(itemId, SYNC_TIMEOUTS.upstreamSnapshotDebounce)
  }

  /** Marks restored items pending and dirty. Whatever they hold that the server lacks gets pushed. */
  async markRestored(itemIds: ItemId[]): Promise<void> {
    this.requestSnapshot(itemIds)
    await this.services.changeOutbox.markAll(itemIds)
  }

  /** Tells the components waiting on a key that the keyring has changed */
  onKeyringUpdated(): void {
    this.services.gapHealer.onKeyringUpdated()
    this.services.firstStart.onKeyringUpdated()
  }

  async initialize(): Promise<void> {
    try {
      await this.initializeLocalData()
    } catch (error) {
      if (error instanceof LocalKeyUnavailableError || error instanceof LocalDataUnreadableError) {
        await this.reportLocalDataUnavailable(error)
      }
      throw error
    }
    await this.lifecycle.start()
    await this.services.accountSettings.load()
    fireAndForget(
      this.services.dataVersionTracker.onStart(this.hasLocalDataAtStart),
      'SyncWorkerContext:recordDeviceDataVersion',
    )
  }

  /** Everything before services start: the device gate, migration, and opening local storage */
  private async initializeLocalData(): Promise<void> {
    // Checked before anything else: starting would record the current level for a device whose
    // only data is in a layout the app no longer reads, stranding that data
    await this.checkDeviceDataVersion()
    // Stores only read the current layout, so the migration runs first. A failure must stop
    // initialization: starting would create an empty index, and a later migration would then keep it
    // over the old one. Local storage is opened under the same lock, before the Repo reads from it.
    const local = await this.withLocalDataLock(async () => {
      await this.config.migrateLocalData?.(this.accountId)
      const opened = await openLocalStorage({
        accountId: this.accountId,
        upgradeLocalEncryption: this.config.upgradeLocalEncryption,
        keys: this.config.localKeys,
        randomDataKeys: this.config.randomDataKeys,
        onRetiring: () => this.clientEventHub.emit({ type: 'retiringLegacyStores', accountId: this.accountId }),
        onOpenFailure: (key, error) => this.handleOpenFailure(key, error),
        onQuotaFallback: () => this.clientEventHub.emit({
          type: 'quotaExceeded',
          message: "There isn't enough storage space to encrypt this device's data. It will be retried later.",
        }),
      })
      try {
        await runFirstStartLocalPart(this.accountId, () => this.listIndexedItems(opened))
      } catch (error) {
        await opened.storage.close()
        throw error
      }
      return opened
    })
    // A shutdown while waiting for the lock has already stopped this context
    if (this.isStopped) {
      await local.storage.close()
      throw new AbortError('The sync worker context was shut down during initialization')
    }
    this.createComponents(local)
    // Checked before starting, which creates an empty index for a new device
    this.hasLocalDataAtStart = await this.services.indexStore.hasIndex()
  }

  private async listIndexedItems(local: LocalStorage): Promise<ItemId[]> {
    const index = await new IndexStore(this.accountId, local.cipher ? { cipher: local.cipher } : undefined).getIndex()
    return index?.itemIds ?? []
  }

  /**
   * Tells the app this device's local data can't be opened, with how many items have changes that may
   * not have been pushed (the outbox's records, which need no key), so it can offer recovery. The data
   * is never reset here.
   */
  private async reportLocalDataUnavailable(error: LocalKeyUnavailableError | LocalDataUnreadableError): Promise<void> {
    let unpushedChanges = 0
    try {
      unpushedChanges = await SyncLogDatabase.countPending(this.accountId)
    } catch (countError) {
      log.warn('Could not count unpushed changes', countError)
    }
    this.clientEventHub.emit({
      type: 'localDataUnavailable',
      ...(error instanceof LocalKeyUnavailableError && error.kver ? { kver: error.kver } : {}),
      unpushedChanges,
    })
  }

  /**
   * Refuses to start when this device's local data is below the app's minimum level, so the app can
   * send it through its migration app. A device without local data starts at the current level.
   */
  private async checkDeviceDataVersion(): Promise<void> {
    const minDataVersion = this.config.minDataVersion ?? 0
    if (minDataVersion === 0) return
    if (await readDeviceDataVersion(this.accountId) >= minDataVersion) return
    // Local storage isn't open yet, but finding an index doesn't need its key
    const hasLocalData = await new IndexStore(this.accountId).hasIndex()
    if (!hasLocalData && !(await this.config.hasLegacyLocalData?.(this.accountId))) return
    this.clientEventHub.emit({ type: 'migrationRequired', reason: 'device' })
    throw new MigrationRequiredError('device')
  }

  /**
   * Runs `task` while holding the account's local data Web Lock. Otherwise a tab could copy an old
   * value over one another tab's engine has already written since migrating, two tabs could each
   * create a device storage key, or a late tab could reset sync state the leader has moved on from.
   */
  private async withLocalDataLock<T>(task: () => Promise<T>): Promise<T> {
    if (typeof navigator !== 'undefined' && navigator?.locks?.request) {
      const lockName = `${getVaultStorageNames().accountPrefixes.localDataMigrationLock}${this.accountId}`
      return navigator.locks.request(lockName, { mode: 'exclusive' }, task)
    }
    return task()
  }

  async shutdown(options?: { clearLocalData?: boolean }): Promise<void> {
    this.isStopped = true
    // Every component stops starting new work before any of them is stopped
    this.session.markShutdown()
    await this.lifecycle.stop(options)
    for (const unsub of this.unsubscribers) {
      unsub()
    }
    this.unsubscribers = []
  }

  /**
   * Wraps the device storage key with the newly active data key, after a deliberate key rotation. The
   * keyring keeps every version, so the old wrap stays readable and a failure here loses nothing: it
   * is logged and left for the next rotation.
   */
  async rewrapDeviceKey(): Promise<void> {
    const storage = this.sealedStorage
    const keys = this.config.localKeys
    if (!storage || !keys) return
    try {
      await this.withLocalDataLock(async () => {
        const rewrapped = await LocalCipher.rewrap(await storage.getMeta(DSK_KEY), keys, this.accountId)
        if (rewrapped) {
          await storage.putMeta(DSK_KEY, rewrapped)
        }
      })
    } catch (error) {
      log.error('Failed to re-wrap the device storage key', error)
    }
  }

  /**
   * Records a document whose sealed chunks failed to decrypt, and quarantines it once. The data is
   * left in place: it's replaced only when the user chooses to (see `ItemRecoveryService.replaceFromServer`).
   */
  private handleOpenFailure(key: string[], error: unknown): void {
    const [documentId] = key
    // The Repo's own storage ID record isn't a document
    if (key.length < 2 || this.unreadableDocuments.has(documentId)) return
    this.unreadableDocuments.add(documentId)
    const itemId = toVaultItemIdFromAutomergeId(documentId as DocumentId)
    const recoveryManager = this._services?.recoveryManager
    if (!recoveryManager) return
    fireAndForget(
      recoveryManager.reportDecryptionFailure(itemId, 'localDecryption', error),
      'SyncWorkerContext:reportDecryptionFailure',
    )
  }

  /** Records whether the device is online, and tells the components that react to it */
  setOnlineState(isOnline: boolean): void {
    if (!this.session.setOnline(isOnline) || !this._services) return
    this._services.orchestrator.onOnlineStateChange()
    this._services.snapshotManager.onOnlineStateChange()
  }

  async retrySave(): Promise<RetrySaveResult> {
    return this.services.storageRecoveryService.retrySave()
  }

  claimLeader(): void {
    this.services.orchestrator.claimLeader()
  }

  /**
   * Records whether this tab is visible. `returned` says the user just came back to it (it became
   * visible or got focus), so the leader polls now if its last poll is stale.
   */
  setVisibility(visible: boolean, returned = false): void {
    this.isVisible = visible
    if (!this._services) return
    this._services.foregroundTracker.setVisible(visible, returned)
    if (returned) {
      this._services.orchestrator.onForeground()
    }
  }

  /**
   * Counts the items whose local changes the server may not have: pending marks or a snapshot still
   * to upload, plus quarantined items. It first gives pending pushes a short chance to finish, so
   * changes about to sync aren't reported.
   */
  async getUnsyncedChanges(): Promise<UnsyncedChanges> {
    const { orchestrator, snapshotManager } = this.services
    orchestrator.flush()
    try {
      await withTimeout(
        SYNC_TIMEOUTS.unsyncedChangesFlush,
        signal => untilAborted(snapshotManager.flushPendingSnapshots(), signal),
      )
    } catch (error) {
      log.warn('Pending snapshots did not finish uploading before counting unsynced changes', error)
    }
    return this.countChanges(snapshotManager.tracker.getDirtyItemIds())
  }

  /**
   * Counts the items whose changes haven't reached the server, without pushing anything first. A
   * snapshot still to upload doesn't count: its changes are already in the log, for other devices to pull.
   */
  async countUnpushedChanges(): Promise<UnsyncedChanges> {
    return this.countChanges([])
  }

  /** Counts the items with pending marks or in `otherItemIds` once each, and quarantined items apart */
  private async countChanges(otherItemIds: ItemId[]): Promise<UnsyncedChanges> {
    const { changeOutbox, recoveryManager } = this.services
    const [pendingItemIds, recoveryEntries] = await Promise.all([
      changeOutbox.listPending(),
      recoveryManager.listRecoveryItems(),
    ])
    const quarantined = new Set(recoveryEntries.map(entry => entry.itemId))
    const pending = new Set([...pendingItemIds, ...otherItemIds])
    for (const itemId of quarantined) {
      pending.delete(itemId)
    }
    return { pendingItems: pending.size, quarantinedItems: quarantined.size }
  }
}
