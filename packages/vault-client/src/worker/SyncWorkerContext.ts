import type { Repo, DocHandle, DocumentId } from '@automerge/automerge-repo/slim'

import { AutomergeDocStore, AutomergeIndexManager } from './docStore'
import type { RepoDoc } from './docStore/AutomergeDocStore'
import { IndexStore } from './stores/IndexStore'
import { LogCursorStore } from './stores/LogCursorStore'
import { SyncLogDatabase } from './stores/SyncLogDatabase'
import { SnapshotPusher } from './SnapshotPusher'
import { SnapshotSchedule } from './SnapshotSchedule'
import { SnapshotBuilder } from './SnapshotBuilder'
import { SyncOrchestrator } from './SyncOrchestrator'
import { SyncPoller } from './SyncPoller'
import { LogExchange } from './LogExchange'
import { ManifestHydrator } from './ManifestHydrator'
import { ManifestDemands } from './ManifestDemands'
import { ManifestSyncManager } from './ManifestSyncManager'
import { ItemOperations } from './ItemOperations'
import { INBOUND_MESSAGE_RESOLVABLE_KINDS, RecoveryManager } from './RecoveryManager'
import { ChangeOutbox, readPendingMarks } from './ChangeOutbox'
import { GapHealer } from './GapHealer'
import { IncomingChanges } from './IncomingChanges'
import { ItemSyncState } from './ItemSyncState'
import { SyncLogPuller } from './SyncLogPuller'
import type { ClientEventHub } from './SyncEventHub'
import { SyncStatusManager } from './SyncStatusManager'
import { SyncProgressTracker } from './SyncProgressTracker'
import { countStuckItems } from './stuckItems'
import { hasFinishedSyncReset, resetSyncState } from './syncReset'
import { LastSyncedStore } from './stores/LastSyncedStore'
import { AutomergeRepoManager } from './AutomergeRepoManager'
import { toVaultItemIdFromAutomergeId, isIndexDocument } from './utils/automerge'
import { settingsDocId, type ItemId } from '@vault/shared'
import { ServiceLifecycleManager, type ServiceRegistration } from './ServiceLifecycleManager'
import type { SyncApiClient } from './SyncApiClient'
import { StorageRecoveryService } from './StorageRecoveryService'
import { ItemRecoveryService } from './ItemRecoveryService'
import { SnapshotRewriter } from './SnapshotRewriter'
import { SnapshotFormatUpgrade } from './SnapshotFormatUpgrade'
import { DataVersionTracker, MigrationRequiredError, readDeviceDataVersion } from './DataVersionTracker'
import { fireAndForget } from '../utils/fireAndForget'
import { RealtimeBus } from './RealtimeBus'
import { ForegroundTracker } from './ForegroundTracker'
import { SyncSessionState } from './SyncSessionState'
import { SyncSignals } from './SyncSignals'
import { DEFAULT_SYNC_DOMAIN, type LegacyHooks, type SyncDomain } from './domain'
import { AccountSettings, withSettingsDocPassthrough } from './AccountSettings'
import { getVaultStorageNames } from '../shared/storageNames'
import { AbortError, untilAborted, withTimeout } from '../utils/abort'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'
import { DSK_KEY, openLocalStorage, type LocalStorage } from './localEncryption/openLocalStorage'
import { LocalCipher, LocalDataUnreadableError, LocalKeyUnavailableError } from './localEncryption/LocalCipher'
import type { KeyProvider, LocalKeyWrapper } from '../keys/Keyring'
import { createLogger } from '../utils/logger'
import type { RetrySaveResult } from './syncProtocol'
import type { SyncDiagnostics, UnpushedChanges, UnsyncedChanges } from '../shared/types'

const log = createLogger('SyncWorkerContext')

/** The host app's settings, which every session's context is built with (see SyncWorkerConfig) */
export interface SyncSessionConfig {
  /** The app's document codec and hooks. Defaults to passing documents through untouched. */
  domain?: SyncDomain
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
   * Seals this device's local data with a device storage key, copying any plaintext data into the
   * sealed stores and then deleting the plaintext ones (see docs/local-encryption.md, Part 2)
   */
  upgradeLocalEncryption?: boolean
  /**
   * The app's data version (`SyncDomain.dataVersion`) at which local data is sealed. The device's
   * recorded level stays below it until its storage is sealed and the plaintext stores are retired.
   */
  sealedDataVersion?: number
  /** Code for data in older formats and layouts (see LegacyHooks). Only an app's migration app passes it. */
  legacy?: LegacyHooks
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
  itemSyncState: ItemSyncState
  docStore: AutomergeDocStore
  indexManager: AutomergeIndexManager
  recoveryManager: RecoveryManager
  changeOutbox: ChangeOutbox
  gapHealer: GapHealer
  puller: SyncLogPuller
  poller: SyncPoller
  snapshotSchedule: SnapshotSchedule
  snapshotPusher: SnapshotPusher
  orchestrator: SyncOrchestrator
  manifestDemands: ManifestDemands
  manifestHydrator: ManifestHydrator
  manifestSyncManager: ManifestSyncManager
  itemOperations: ItemOperations
  storageRecoveryService: StorageRecoveryService
  itemRecoveryService: ItemRecoveryService
  snapshotRewriter: SnapshotRewriter
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
    this.registerLifecycleServices(services)
  }

  /**
   * Builds the components in the order data flows through them, so each takes the ones it calls. The
   * events that point back up that order go through `signals`, bound once every component exists.
   */
  private createServices(local: LocalStorage): SyncWorkerServices {
    const { accountId, keys, clientEventHub } = this.config
    const { session } = this
    const signals = new SyncSignals()
    const realtimeBus = new RealtimeBus(accountId)
    const foregroundTracker = new ForegroundTracker({
      bus: realtimeBus,
      isVisible: this.isVisible,
      onPeerReturned: () => signals.raise.foreground(),
      onActivity: () => signals.raise.activity(),
      isLeader: () => session.isLeader,
      onLeaderAway: () => signals.raise.leaderAway(),
    })
    const cipherOptions = local.cipher ? { cipher: local.cipher } : undefined
    const indexStore = new IndexStore(accountId, cipherOptions)
    const syncLogDatabase = new SyncLogDatabase(accountId)
    const itemSyncState = new ItemSyncState({ db: syncLogDatabase, session })

    const repoManager = new AutomergeRepoManager(accountId, keys, local.storage, {
      bus: realtimeBus,
      onKeyVersionMissing: this.emitKeyVersionMissing,
      onDocumentReceived: docId => this.notifyDocumentReceived(toVaultItemIdFromAutomergeId(docId)),
      // The leader's backstop for follower changes that arrive after their marks were cleared
      onDocChanged: itemId => signals.raise.docChanged(itemId),
    })
    const { repo } = repoManager

    const docStore = new AutomergeDocStore({
      repo,
      onHandleReplaced: this.config.onDocHandleReplaced,
      watchHandle: handle => repoManager.watchHandle(handle),
      storageAdapter: repoManager.storage,
      codec: this.domain.codec,
      isLocallyUnreadable: documentId => this.unreadableDocuments.has(documentId),
      onLocalDataMissing: itemId => signals.raise.localDataMissing(itemId),
    })

    const settingsId = settingsDocId(accountId)
    const indexManager = new AutomergeIndexManager({
      accountId,
      indexStore,
      bus: realtimeBus,
      onIndexUpdated: itemIds => {
        this.config.onIndexUpdated?.(itemIds)
        clientEventHub.emit({ type: 'indexUpdated', itemIds: itemIds.filter(id => id !== settingsId) })
      },
      onMetadataUpdated: metadata => signals.raise.metadataUpdated(metadata),
    })

    const recoveryManager = new RecoveryManager({ accountId, eventHub: clientEventHub })

    const syncProgress = new SyncProgressTracker({
      eventHub: clientEventHub,
      store: new LastSyncedStore(accountId),
      countUnpushedChanges: () => this.countUnpushedChanges(),
    })

    const snapshotSchedule = new SnapshotSchedule({
      state: itemSyncState,
      recoveryManager,
      session,
      onDueChanged: () => signals.raise.snapshotDue(),
    })

    const snapshotBuilder = new SnapshotBuilder(repo, keys, this.domain.codec, itemSyncState)

    // Only the mark: the leader's push acknowledgement marks the item dirty for its snapshot
    const markDocumentDirty = (itemId: ItemId) => signals.raise.edited(itemId)

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
      legacySettings: this.legacy.legacySettings,
      withAuth: request => this.apiClient.executeWithAuth(request),
    })

    const storeItems: ItemOperations['storeItems'] = (items, options) => itemOperations.storeItems(items, options)

    // A merged or covered snapshot's heads are on the server, but this device's server heads may
    // already be past them, such as after it pushed rows a stale snapshot lacks
    const advanceServerHeads = (itemId: ItemId, heads: string[]) =>
      itemSyncState.advanceServerHeads(itemId, heads, docStore.readLoadedDoc(itemId))

    const manifestHydrator = new ManifestHydrator({
      accountId,
      session,
      apiClient: this.apiClient,
      docStore,
      indexManager,
      itemSyncState,
      snapshotSchedule,
      keys,
      storeItems,
      onKeyVersionMissing: this.emitKeyVersionMissing,
      decodeLegacyItem: this.legacy.decodeLegacyItem,
      onMigrationRequired: () => clientEventHub.emit({ type: 'migrationRequired', reason: 'account' }),
      onDecryptionFailure: (itemId, error, serverVersion) => {
        fireAndForget(
          recoveryManager.reportDecryptionFailure(itemId, 'snapshotDecryption', error, { serverVersion }),
          'SyncWorkerContext:reportDecryptionFailure',
        )
      },
      // Quarantined with the version that failed, so manifest sync skips it until the server has a newer one
      // The hydrator logs the error, which can quote decrypted content, so it isn't stored
      onRepeatedHydrationError: (itemId, _error, serverVersion) => {
        fireAndForget(
          recoveryManager.quarantine(itemId, 'unknown', { code: 'hydrationFailed' }, { serverVersion }),
          'SyncWorkerContext:quarantineRepeatedHydrationError',
        )
      },
      onItemSnapshotHydrated: advanceServerHeads,
      onLocalChangesFound: itemId => signals.raise.localChangesFound(itemId),
    })

    const incoming = new IncomingChanges({
      docStore,
      marks: readPendingMarks(syncLogDatabase),
      itemSyncState,
      onItemApplied: itemId => this.notifyDocumentReceived(itemId),
    })

    const gapHealer = new GapHealer({
      db: syncLogDatabase,
      keys,
      docStore,
      indexManager,
      incoming,
      recoveryManager,
      fetchSnapshots: (itemIds, signal) => manifestHydrator.fetchSnapshots(itemIds, signal),
      onWorkDue: () => signals.raise.workDue(),
      onKeyVersionMissing: this.emitKeyVersionMissing,
      onHealingChange: isHealing => this.statusManager.setDegradedPull(isHealing),
    })

    const manifestDemands = new ManifestDemands()

    const puller = new SyncLogPuller({
      cursorStore: new LogCursorStore(accountId),
      docs: docStore,
      keys,
      session,
      incoming,
      healer: gapHealer,
      manifest: manifestDemands,
      itemSyncState,
      bus: realtimeBus,
      onKeyVersionMissing: this.emitKeyVersionMissing,
      onRemoteChangesApplied: itemIds => {
        // Someone is using another device, so poll at the active rate while a tab is visible
        foregroundTracker.noteActivity()
        fireAndForget(
          recoveryManager.resolveQuarantines(itemIds, INBOUND_MESSAGE_RESOLVABLE_KINDS),
          'SyncWorkerContext:resolveQuarantines',
        )
      },
      // At start and on promotion, so this is the one place the item records load
      onLoad: async () => {
        await Promise.all([snapshotSchedule.load(), gapHealer.load()])
      },
    })

    const logExchange = new LogExchange({ accountId, session, puller, apiClient: this.apiClient })

    const changeOutbox = new ChangeOutbox({
      db: syncLogDatabase,
      docStore,
      keys,
      session,
      itemSyncState,
      exchange: logExchange.exchange,
      // Without debouncing, so the item's full state is delivered
      requestSnapshot: itemId => snapshotSchedule.markItemDirty(itemId, 0),
      onMarked: () => {
        signals.raise.workDue()
        syncProgress.scheduleRecount()
      },
      // The leader's acknowledgement is the one place an edit makes its item dirty
      onAcknowledged: itemId => snapshotSchedule.markItemDirty(itemId),
    })

    const pushToLog = (itemIds: ItemId[], signal?: AbortSignal) => changeOutbox.pushItems(itemIds, signal)

    const snapshotPusher = new SnapshotPusher({
      accountId,
      session,
      schedule: snapshotSchedule,
      state: itemSyncState,
      builder: snapshotBuilder,
      pushToLog,
      onSnapshotStored: details => itemSyncState.confirmSnapshotOnly(details.itemId, details.heads),
      eventHub: clientEventHub,
      recoveryManager,
      apiClient: this.apiClient,
      runPollNow: () => signals.raise.pollNow(),
      isCaughtUp: () => puller.isCaughtUp,
      hasPendingMarks: async () => (await changeOutbox.listPending()).length > 0,
    })

    const snapshotRewriter = new SnapshotRewriter({
      uploader: snapshotPusher,
      schedule: snapshotSchedule,
      indexManager,
      apiClient: this.apiClient,
      session,
      claimLeader: () => signals.raise.claimLeader(),
      catchUp: puller,
      runPollNow: () => signals.raise.pollNow(),
      onStage: stage => this.clientEventHub.emit({ type: 'reencryptStage', stage }),
    })

    const dataVersionTracker = new DataVersionTracker({
      accountId,
      dataVersion: this.domain.dataVersion ?? 0,
      raiseAccountDataVersion: () => this.apiClient.raiseDataVersion({ account: accountId }),
      maxDeviceVersion: this.maxDeviceVersion(accountSettings),
    })

    const snapshotFormatUpgrade = this.legacy.upgradeSnapshotFormat
      ? new SnapshotFormatUpgrade({
        accountId,
        session,
        onUpgraded: () => fireAndForget(
          dataVersionTracker.onSnapshotsUpgraded(),
          'SyncWorkerContext:raiseAccountDataVersion',
        ),
        rewriteSnapshots: signal => snapshotRewriter.request({ signal }),
      })
      : null

    const manifestSyncManager = new ManifestSyncManager({
      accountId,
      session,
      docStore,
      indexManager,
      snapshotSchedule,
      snapshotPusher,
      keys,
      recoveryManager,
      apiClient: this.apiClient,
      demands: manifestDemands,
      hydrator: manifestHydrator,
      storeItems,
      // Without a legacy source there is nothing to move: the main app's device gate keeps out the
      // local layouts that held synced keys (a device with keys left is never recorded as migrated,
      // see `maxDeviceVersion`), and `AccountSettings.mutate` never writes them locally
      migrateLegacySettings: this.legacy.legacySettings ? () => accountSettings.migrateLegacySettings() : undefined,
      fetchManifestEverySync: this.legacy.fetchManifestEverySync,
      onSyncedWithoutFailures: () => {
        snapshotFormatUpgrade?.onSyncedWithoutFailures()
        fireAndForget(dataVersionTracker.onSyncedWithoutFailures(), 'SyncWorkerContext:recordDeviceDataVersion')
      },
      onSnapshotCovered: advanceServerHeads,
      onManifestProcessed: async () => {
        // A sync that began before this tab stopped leading can still finish here
        if (!session.isLeader) return
        gapHealer.onManifestSynced()
      },
      itemSyncState,
    })

    const poller = new SyncPoller({
      session,
      puller,
      exchange: logExchange,
      outbox: changeOutbox,
      healer: gapHealer,
      runManifestPhase: (stage, signal) => manifestSyncManager.runPhase(stage, signal),
      snapshots: snapshotPusher,
      rewrites: snapshotRewriter,
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
        // The records load with the log state, which the first poll waits for (see `puller`'s onLoad)
        snapshotSchedule.onLeaderChange()
        snapshotFormatUpgrade?.onLeaderChange()
        foregroundTracker.onLeaderChange()
      },
      onPollResult: outcome => {
        this.statusManager.handlePollResult(outcome)
        syncProgress.onPollResult(outcome)
      },
      getCadence: () => {
        if (!foregroundTracker.isAnyVisible) return 'hidden'
        return foregroundTracker.isActive ? 'active' : 'idle'
      },
      getSnapshotDueAt: () => snapshotSchedule.nextDueAt,
    })

    const storageRecoveryService = new StorageRecoveryService({
      session,
      clientEventHub,
      outbox: changeOutbox,
      docStore,
      itemSyncState,
      snapshotPusher,
      metadataStore: indexStore,
      orchestrator,
    })

    const itemRecoveryService = new ItemRecoveryService({
      repoManager,
      docStore,
      recoveryManager,
      snapshotSchedule,
      snapshotPusher,
      syncManifest: mode => orchestrator.syncManifest(mode),
      itemOperations,
      becomeLeader: () => this.becomeLeader(),
      onLocalCopyDiscarded: documentId => this.unreadableDocuments.delete(documentId),
    })

    signals.bind({
      workDue: () => orchestrator.flush(),
      snapshotDue: () => orchestrator.onSnapshotDue(),
      pollNow: () => orchestrator.pollNow(),
      foreground: () => orchestrator.onForeground(),
      activity: () => orchestrator.onActivity(),
      leaderAway: () => orchestrator.followVisibleTab(),
      claimLeader: () => fireAndForget(orchestrator.claimLeader(), 'SyncWorkerContext:claimLeader'),
      docChanged: itemId => changeOutbox.onDocChanged(itemId),
      edited: itemId => {
        fireAndForget(changeOutbox.mark(itemId), 'SyncWorkerContext:markPending')
        storageRecoveryService.recordEdit(itemId)
      },
      localChangesFound: itemId => fireAndForget(changeOutbox.mark(itemId), 'SyncWorkerContext:markPending'),
      localDataMissing: itemId => gapHealer.requestSnapshot(itemId),
      metadataUpdated: metadata => accountSettings.handleLocalMetadata(metadata),
    })

    return {
      realtimeBus,
      foregroundTracker,
      repo,
      repoManager,
      syncLogDatabase,
      indexStore,
      itemSyncState,
      docStore,
      indexManager,
      recoveryManager,
      changeOutbox,
      gapHealer,
      puller,
      poller,
      snapshotSchedule,
      snapshotPusher,
      orchestrator,
      manifestDemands,
      manifestHydrator,
      manifestSyncManager,
      itemOperations,
      storageRecoveryService,
      itemRecoveryService,
      snapshotRewriter,
      accountSettings,
      snapshotFormatUpgrade,
      dataVersionTracker,
      syncProgress,
    }
  }

  /** The migration app's legacy hooks, or none */
  private get legacy(): LegacyHooks {
    return this.config.legacy ?? {}
  }

  /** Whether a device this session can start on may not have reset its sync state (see `syncResetDataVersion`) */
  private get needsSyncReset(): boolean {
    const { minDataVersion } = this.config
    const { syncResetDataVersion } = this.legacy
    return syncResetDataVersion !== undefined && (minDataVersion ?? 0) < syncResetDataVersion
  }

  /**
   * Caps the recorded device level below the sealed level until this session's storage is sealed and
   * no plaintext stores are left, so a device on the quota fallback or the password-derived-key guard
   * isn't recorded as migrated. Caps it below the sync reset level until the reset has finished.
   *
   * With a legacy settings source, records no level at all while synced keys are left in local
   * metadata. Moving them can fail without failing the sync, and the main app doesn't move them, so
   * a device recorded as migrated with keys left would never sync them.
   */
  private maxDeviceVersion(accountSettings: AccountSettings): (() => Promise<number>) | undefined {
    const { sealedDataVersion } = this.config
    const resetDataVersion = this.needsSyncReset ? this.legacy.syncResetDataVersion : undefined
    const migratesLegacySettings = this.legacy.legacySettings !== undefined
    if (sealedDataVersion === undefined && resetDataVersion === undefined && !migratesLegacySettings) return undefined
    return async () => {
      if (migratesLegacySettings && await accountSettings.hasLocalSyncedKeys()) {
        return 0
      }
      const state = this.localStorageState
      if (sealedDataVersion !== undefined && !(state?.mode === 'sealed' && state.retired)) {
        return sealedDataVersion - 1
      }
      if (resetDataVersion !== undefined && !await hasFinishedSyncReset(this.accountId)) {
        return resetDataVersion - 1
      }
      return Number.POSITIVE_INFINITY
    }
  }

  private notifyDocumentReceived(itemId: ItemId): void {
    if (itemId && !isIndexDocument(itemId)) {
      this.config.onDocumentReceived?.(itemId)
    }
  }

  private registerLifecycleServices(services: SyncWorkerServices): void {
    const {
      realtimeBus, foregroundTracker, repoManager, syncLogDatabase, storageRecoveryService, indexManager, recoveryManager,
      docStore, snapshotSchedule, snapshotPusher, itemSyncState, changeOutbox, puller, orchestrator, snapshotRewriter, snapshotFormatUpgrade, syncProgress,
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
      // Stops after everything that changes the records, and saves what they changed
      { name: 'ItemSyncState', onStop: options => itemSyncState.shutdown(options) },
      {
        name: 'StorageRecoveryService',
        onStart: () => storageRecoveryService.start(),
        onStop: () => storageRecoveryService.stop(),
      },
      { name: 'IndexManager', onStop: () => indexManager.close() },
      { name: 'IndexDocument', onStart: () => indexManager.ensureIndexDocument() },
      { name: 'RecoveryManager', onStop: () => recoveryManager.resetRecoveryState() },
      { name: 'DocStore', onStop: () => docStore.shutdown() },
      { name: 'SnapshotSchedule', onStop: () => snapshotSchedule.shutdown() },
      { name: 'SnapshotPusher', onStop: () => snapshotPusher.shutdown() },
      { name: 'ChangeOutbox', onStop: () => changeOutbox.shutdown() },
      {
        name: 'SyncLogPuller',
        onStart: () => puller.loadState(),
        onStop: options => puller.shutdown(options),
      },
      {
        name: 'SyncOrchestrator',
        onStart: () => orchestrator.start(),
        onStop: () => orchestrator.shutdown(),
      },
      { name: 'SnapshotRewriter', onStop: () => snapshotRewriter.cancel() },
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
      this.services.snapshotSchedule.markItemDirty(itemId, 0)
    }
  }

  /**
   * Marks restored items pending, so whatever they hold that the server lacks gets pushed, and on the
   * leader asks for their snapshots. A follower's restored items become dirty when the leader's push
   * is acknowledged.
   */
  async markRestored(itemIds: ItemId[]): Promise<void> {
    if (this.session.isLeader) this.requestSnapshot(itemIds)
    await this.services.changeOutbox.markAll(itemIds)
  }

  /** Tells the components waiting on a key that the keyring has changed */
  onKeyringUpdated(): void {
    this.services.gapHealer.onKeyringUpdated()
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
      await this.legacy.migrateLocalData?.(this.accountId)
      const opened = await openLocalStorage({
        accountId: this.accountId,
        upgradeLocalEncryption: this.config.upgradeLocalEncryption,
        keys: this.config.localKeys,
        onRetiring: () => this.clientEventHub.emit({ type: 'retiringLegacyStores', accountId: this.accountId }),
        onOpenFailure: (key, error) => this.handleOpenFailure(key, error),
        onQuotaFallback: () => this.clientEventHub.emit({
          type: 'quotaExceeded',
          message: "There isn't enough storage space to encrypt this device's data. It will be retried later.",
        }),
      })
      try {
        if (this.needsSyncReset) {
          await resetSyncState(this.accountId, () => this.listIndexedItems(opened))
        }
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
  }

  async retrySave(): Promise<RetrySaveResult> {
    return this.services.storageRecoveryService.retrySave()
  }

  /**
   * Makes this tab the leader, which talks to the server, for a user action that has to. It steals
   * the leader lock, and the tab that held it stops leading.
   */
  async becomeLeader(): Promise<void> {
    if (this.session.isLeader) return
    await this.services.orchestrator.claimLeader()
    if (!this.session.isLeader) {
      throw new Error('This tab could not take over syncing')
    }
  }

  /**
   * Loads the account's items from the server when a session starts, with a poll that runs a manifest
   * sync. Only the leader talks to the server, so another tab has nothing to do: the leader's docs
   * reach it through shared storage and the broadcast channel. A tab that becomes the leader later
   * syncs then. Throws if a device with no items couldn't fetch the manifest, unless the session has
   * expired, so that starting up is retried; a device with items carries on with them.
   */
  async bootstrapItems(): Promise<void> {
    const { orchestrator, indexManager } = this.services
    if (!(await orchestrator.settleLeadership())) return
    const result = await orchestrator.syncManifest('due')
    if (result.fetchedManifest || result.success || orchestrator.isAuthPaused) return
    if ((await indexManager.listItemIds()).length === 0) {
      throw new Error('Could not load the account\'s items from the server')
    }
  }

  /** Fetches every item the server has a newer copy of, quarantined ones too. Returns whether it all merged. */
  async fullResync(): Promise<boolean> {
    await this.becomeLeader()
    const { orchestrator } = this.services
    const result = await orchestrator.syncManifest('force')
    if (result.success) {
      orchestrator.flush()
    }
    return result.success
  }

  /** What this session is waiting on, for a migration app to report when it stalls */
  getSyncDiagnostics(): SyncDiagnostics {
    const { puller, snapshotRewriter } = this.services
    return {
      isLeader: this.session.isLeader,
      isOnline: this.session.isOnline,
      caughtUp: puller.isCaughtUp,
      reencryptStage: snapshotRewriter.stage,
    }
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
   * Saves the item records now, so the startup audit finds the leader's dirty flags if the page is
   * closed, and flushes the log push. Snapshots aren't forced up: the log already delivers the change.
   */
  onPageHidden(): void {
    const { orchestrator, itemSyncState } = this.services
    itemSyncState.flushPendingSave()
    orchestrator.flush()
  }

  /** Records that the user is using this tab, and tells the account's other tabs */
  reportActivity(): void {
    this._services?.foregroundTracker.recordActivity()
  }

  /**
   * Counts the items whose local changes the server may not have: pending marks or a snapshot still
   * to upload, plus quarantined items. It first gives pending pushes a short chance to finish, so
   * changes about to sync aren't reported. Snapshots still to upload are read from the stored dirty
   * flags, which only the leader writes, so a follower counts what the leader has pushed but not
   * uploaded.
   */
  async getUnsyncedChanges(): Promise<UnsyncedChanges> {
    const { orchestrator, snapshotPusher, itemSyncState } = this.services
    orchestrator.flush()
    try {
      await withTimeout(
        SYNC_TIMEOUTS.unsyncedChangesFlush,
        signal => untilAborted(snapshotPusher.flushPendingSnapshots(), signal),
      )
    } catch (error) {
      log.warn('Pending snapshots did not finish uploading before counting unsynced changes', error)
    }
    // Keeps this tab's unsaved values, so the leader's own queue counts too
    await itemSyncState.load()
    return this.countChanges(itemSyncState.listFlagged())
  }

  /**
   * Counts the items whose changes haven't reached the server, without pushing anything first. A
   * snapshot still to upload doesn't count: its changes are already in the log, for other devices to pull.
   * Also counts the items that have waited too long, by what holds them up.
   */
  async countUnpushedChanges(): Promise<UnpushedChanges> {
    const { changeOutbox, recoveryManager } = this.services
    const [marks, recoveryEntries] = await Promise.all([
      changeOutbox.listMarks(),
      recoveryManager.listRecoveryItems(),
    ])
    const quarantined = new Set(recoveryEntries.map(entry => entry.itemId))
    const pending = marks.filter(mark => !quarantined.has(mark.itemId))
    const stuckItems = countStuckItems(pending, Date.now())
    return {
      pendingItems: pending.length,
      quarantinedItems: quarantined.size,
      ...(stuckItems ? { stuckItems } : {}),
    }
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
