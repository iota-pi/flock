import type { Repo, DocHandle, DocumentId } from '@automerge/automerge-repo/slim'
import * as Automerge from '@automerge/automerge/slim'

import { AutomergeDocStore, AutomergeIndexManager } from './docStore'
import { IndexStore } from './stores/IndexStore'
import { CursorStore } from './stores/CursorStore'
import { LastModifiedStore } from './stores/LastModifiedStore'
import { SyncedHeadsStore } from './stores/SyncedHeadsStore'
import { SnapshotManager } from './SnapshotManager'
import { SyncOrchestrator } from './SyncOrchestrator'
import { ManifestSyncManager } from './ManifestSyncManager'
import { ItemOperations } from './ItemOperations'
import { INBOUND_MESSAGE_RESOLVABLE_KINDS, RecoveryManager } from './RecoveryManager'
import { SyncMessageBroker } from './SyncMessageBroker'
import { VaultNetworkAdapter } from './VaultNetworkAdapter'
import { ClientEventHub, WorkerInternalEventHub } from './SyncEventHub'
import { SyncPullQueueManager } from './SyncPullQueueManager'
import { SyncWriteAheadLog } from './SyncWriteAheadLog'
import { AutomergeRepoManager } from './AutomergeRepoManager'
import { toDocumentIdFromItemId, toVaultItemIdFromAutomergeId, isIndexDocument } from './utils/automerge'
import type { ItemId } from '@vault/shared'
import { ServiceLifecycleManager, type LifecycleAware } from './ServiceLifecycleManager'
import { SyncApiClient } from './SyncApiClient'
import { StorageRecoveryService } from './StorageRecoveryService'
import { ItemReencryptor, type StoredSnapshot } from './reencryptAllItems'
import { SnapshotFormatUpgrade } from './SnapshotFormatUpgrade'
import { DataVersionTracker, MigrationRequiredError, readDeviceDataVersion } from './DataVersionTracker'
import { fireAndForget } from '../utils/fireAndForget'
import { publishRealtimeBusItemDirty, subscribeRealtimeBusItemDirty } from './realtimeBus'
import { DEFAULT_SYNC_DOMAIN, type SyncDomain } from './domain'
import { AccountSettings, withSettingsDocPassthrough } from './AccountSettings'
import { getVaultStorageNames } from '../shared/storageNames'
import { AbortError } from '../utils/abort'
import { DSK_KEY, openLocalStorage, type LocalStorage } from './localEncryption/openLocalStorage'
import { LocalCipher, LocalDataUnreadableError, LocalKeyUnavailableError } from './localEncryption/LocalCipher'
import type { KeyProvider, LocalKeyWrapper } from '../../api/Keyring'
import { createLogger } from '../utils/logger'
import type { RetrySaveResult } from './syncProtocol'

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
   * Fetches the manifest on every sync, rather than at most daily on a device that has items, so
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
  internalEventHub: WorkerInternalEventHub
  /**
   * Called when the Automerge repo receives a new document from the network,
   * so the Comlink layer can subscribe to change events on that handle.
   */
  onDocumentReceived?: (itemId: ItemId) => void
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
  repo: Repo
  repoManager: AutomergeRepoManager
  adapter: VaultNetworkAdapter
  broker: SyncMessageBroker
  indexStore: IndexStore
  cursorStore: CursorStore
  lastModifiedStore: LastModifiedStore
  syncedHeadsStore: SyncedHeadsStore
  wal: SyncWriteAheadLog
  docStore: AutomergeDocStore
  indexManager: AutomergeIndexManager
  recoveryManager: RecoveryManager
  pullQueueManager: SyncPullQueueManager
  snapshotManager: SnapshotManager
  orchestrator: SyncOrchestrator
  manifestSyncManager: ManifestSyncManager
  itemOperations: ItemOperations
  storageRecoveryService: StorageRecoveryService
  itemReencryptor: ItemReencryptor
  accountSettings: AccountSettings
  snapshotFormatUpgrade: SnapshotFormatUpgrade | null
  dataVersionTracker: DataVersionTracker
}

export class SyncWorkerContext {
  public readonly accountId: string
  public readonly clientEventHub: ClientEventHub
  public readonly internalEventHub: WorkerInternalEventHub
  public readonly apiClient: SyncApiClient
  public readonly domain: SyncDomain
  public readonly lifecycle = new ServiceLifecycleManager<{ clearLocalData?: boolean }>('SyncWorkerContext')
  /** How this session stores local data, once `initialize` has opened it */
  public localStorageState: Pick<LocalStorage, 'mode' | 'retired'> | null = null

  private _services: SyncWorkerServices | null = null
  private unsubscribers: Array<() => void> = []
  private isStopped = false
  private hasLocalDataAtStart = false
  /** Documents whose sealed records failed to decrypt this session (see AutomergeDocStore.isLocallyUnreadable) */
  private readonly unreadableDocuments = new Set<string>()
  /** The sealed database, whose `meta` store holds the wrapped device storage key */
  private sealedStorage: LocalStorage['storage'] | null = null
  private readonly config: SyncWorkerContextConfig

  constructor(config: SyncWorkerContextConfig) {
    this.config = config
    this.accountId = config.accountId
    this.clientEventHub = config.clientEventHub
    this.internalEventHub = config.internalEventHub
    const domain = config.domain ?? DEFAULT_SYNC_DOMAIN
    this.domain = { ...domain, codec: withSettingsDocPassthrough(domain.codec, config.accountId) }
    this.apiClient = config.apiClient
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
    services.snapshotManager.setLeader(services.orchestrator.leader)
    services.orchestrator.setManifestSyncManager(services.manifestSyncManager)
    this.subscribeInternalEvents(services)
    this.subscribeCrossTabDirtyItems(services)
    this.registerLifecycleServices(services)
  }

  private createServices(local: LocalStorage): SyncWorkerServices {
    const { accountId, keys, clientEventHub, internalEventHub } = this.config
    const cipherOptions = local.cipher ? { cipher: local.cipher } : undefined
    const indexStore = new IndexStore(accountId, cipherOptions)
    const cursorStore = new CursorStore(accountId)
    const lastModifiedStore = new LastModifiedStore(accountId)
    const syncedHeadsStore = new SyncedHeadsStore(accountId)
    const wal = new SyncWriteAheadLog(accountId, internalEventHub, cipherOptions)

    const { adapter, repoManager, repo } = this.createNetworkAndRepo(local.storage, syncedHeadsStore)

    const docStore = new AutomergeDocStore(repo, internalEventHub, repoManager.getStorage(), this.domain.codec)
    docStore.isLocallyUnreadable = documentId => this.unreadableDocuments.has(documentId)

    // The settings are created later, so these callbacks read them from the finished services
    const indexManager = new AutomergeIndexManager(
      accountId,
      indexStore,
      itemIds => {
        this.config.onIndexUpdated?.(itemIds)
        const settingsId = this._services?.accountSettings.docId
        clientEventHub.emit({ type: 'indexUpdated', itemIds: itemIds.filter(id => id !== settingsId) })
      },
      metadata => this._services?.accountSettings.handleLocalMetadata(metadata),
    )

    const pullQueueManager = new SyncPullQueueManager(cursorStore, keys, docStore, internalEventHub)
    const recoveryManager = new RecoveryManager({ accountId, eventHub: clientEventHub })

    const broker = new SyncMessageBroker({
      adapter,
      clientEventHub,
      internalEventHub,
      indexManager,
      pullQueueManager,
      keys,
      wal,
      apiClient: this.apiClient,
      recoveryManager,
      // The storage recovery service takes the broker, so it's read once the services are built
      onQuotaExceeded: error => this.services.storageRecoveryService.handleQuotaExceeded(error),
    })

    const snapshotManager = new SnapshotManager(
      {
        accountId,
        repo,
        broker,
        getLatestCursor: () => pullQueueManager.getGlobalLatestCursor(),
        eventHub: clientEventHub,
        recoveryManager,
        apiClient: this.apiClient,
        codec: this.domain.codec,
        keys,
      },
      lastModifiedStore
    )

    const orchestrator = new SyncOrchestrator({ accountId, broker, clientEventHub, internalEventHub, pullQueueManager })

    const markDocumentDirty = (id: ItemId) => {
      snapshotManager.markItemDirty(id)
      // Only the leader uploads snapshots, so tell it about edits made in this tab
      publishRealtimeBusItemDirty(accountId, [id])
    }

    const itemOperations = new ItemOperations({
      accountId,
      docStore,
      indexManager,
      eventHub: clientEventHub,
      markDocumentDirty,
      recoveryManager,
      hooks: this.domain.hooks,
    })

    const accountSettings = new AccountSettings({
      accountId,
      docStore,
      indexManager,
      eventHub: clientEventHub,
      markDocumentDirty,
      syncedKeys: this.domain.syncedMetadataKeys,
      legacySettings: this.domain.legacySettings,
      withAuth: request => this.apiClient.executeWithAuth(request),
    })

    const itemReencryptor = new ItemReencryptor({
      codec: this.domain.codec,
      keys,
      onSnapshotsStored: stored => this.recordStoredSnapshots(stored, snapshotManager, broker),
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
        onUpgraded: () => fireAndForget(
          dataVersionTracker.onSnapshotsUpgraded(),
          'SyncWorkerContext:raiseAccountDataVersion',
        ),
        rewriteSnapshots: signal => itemReencryptor.reencryptAllItems({
          accountId,
          signal,
          repo,
          indexManager,
          apiClient: this.apiClient,
          recoveryManager,
        }),
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
      onKeyVersionMissing: kver => clientEventHub.emit({ type: 'keyVersionMissing', kver }),
      storeItems: (items, options) => itemOperations.storeItems(items, options),
      decodeLegacyItem: this.domain.decodeLegacyItem,
      migrateLegacySettings: () => accountSettings.migrateLegacySettings(),
      onMigrationRequired: () => clientEventHub.emit({ type: 'migrationRequired', reason: 'account' }),
      fetchManifestEverySync: this.config.fetchManifestEverySync,
      onSyncedWithoutFailures: () => {
        snapshotFormatUpgrade?.onSyncedWithoutFailures()
        fireAndForget(dataVersionTracker.onSyncedWithoutFailures(), 'SyncWorkerContext:recordDeviceDataVersion')
      },
      onDecryptionFailure: (itemId, error) => {
        fireAndForget(recoveryManager.reportDecryptionFailure(itemId, 'snapshotDecryption', error), 'SyncWorkerContext:reportDecryptionFailure')
      },
      onItemSnapshotHydrated: (itemId, heads) => {
        const docId = toDocumentIdFromItemId(itemId)
        adapter.setSyncedHeads(docId, heads)
      },
    })

    const storageRecoveryService = new StorageRecoveryService({
      accountId,
      clientEventHub,
      wal,
      docStore,
      snapshotManager,
      lastModifiedStore,
      broker,
      adapter,
      orchestrator,
    })

    return {
      repo,
      repoManager,
      adapter,
      broker,
      indexStore,
      cursorStore,
      lastModifiedStore,
      syncedHeadsStore,
      wal,
      docStore,
      indexManager,
      recoveryManager,
      pullQueueManager,
      snapshotManager,
      orchestrator,
      manifestSyncManager,
      itemOperations,
      storageRecoveryService,
      itemReencryptor,
      accountSettings,
      snapshotFormatUpgrade,
      dataVersionTracker,
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

  /** Records snapshots uploaded outside the snapshot pusher (by re-encryption), as the pusher does */
  private async recordStoredSnapshots(
    stored: StoredSnapshot[],
    snapshotManager: SnapshotManager,
    broker: SyncMessageBroker,
  ): Promise<void> {
    const versions: [ItemId, number][] = stored.flatMap(({ itemId, version }) => (
      typeof version === 'number' ? [[itemId, version] as [ItemId, number]] : []
    ))
    if (versions.length > 0) {
      await snapshotManager.importVersions(versions)
    }
    for (const { itemId, heads } of stored) {
      if (heads && heads.length > 0) {
        broker.setSyncedHeads(itemId, heads)
      }
    }
  }

  private createNetworkAndRepo(storage: LocalStorage['storage'], syncedHeadsStore: SyncedHeadsStore) {
    const adapter = new VaultNetworkAdapter(this.internalEventHub)
    const repoManager = new AutomergeRepoManager(this.accountId, this.config.keys)
    const repo = repoManager.init(adapter, storage, {
      onKeyVersionMissing: kver => this.clientEventHub.emit({ type: 'keyVersionMissing', kver }),
      onDocumentReceived: docId => {
        const itemId = toVaultItemIdFromAutomergeId(docId)
        if (itemId && !isIndexDocument(itemId)) {
          this.config.onDocumentReceived?.(itemId)
        }
      },
      onQuotaError: error => {
        const storageRecoveryService = this._services?.storageRecoveryService
        if (storageRecoveryService) {
          fireAndForget(storageRecoveryService.handleQuotaExceeded(error), 'SyncWorkerContext:onQuotaError')
        }
      },
    })
    adapter.setSyncedHeadsStore(syncedHeadsStore)
    adapter.setHeadsValidator((documentId, heads) => {
      const handle = repo.handles[documentId] as DocHandle<unknown> | undefined
      if (!handle?.isReady()) return false
      const doc = handle.doc()
      return doc ? Automerge.hasHeads(doc, heads) : false
    })
    return { adapter, repoManager, repo }
  }

  private subscribeCrossTabDirtyItems({ snapshotManager }: SyncWorkerServices): void {
    const unsub = subscribeRealtimeBusItemDirty(this.accountId, itemIds => {
      for (const itemId of itemIds) {
        snapshotManager.markItemDirty(itemId)
      }
    })
    this.unsubscribers.push(unsub)
  }

  private registerLifecycleServices(services: SyncWorkerServices): void {
    const { syncedHeadsStore, adapter } = services
    const syncedHeadsService: LifecycleAware = {
      lifecycleName: 'SyncedHeads',
      onLifecycleStart: async () => {
        const storedHeads = await syncedHeadsStore.loadSyncedHeads()
        if (storedHeads && storedHeads.length > 0) {
          adapter.loadSyncedHeads(storedHeads)
        }
      },
    }

    // Teardown runs in LIFO order (reverse registration order).
    // Startup runs in FIFO order (registration order).
    // Register items that should stop last first, and items that should stop first last.
    //
    // Note: Local storage clearing during account logout is handled exclusively by the
    // main thread (clearAccountLocalData in localDataCleanup.ts) after the worker has cleanly
    // closed all connections. The worker must not attempt to clear databases on shutdown.
    const lifecycleServices: LifecycleAware<{ clearLocalData?: boolean }>[] = [
      services.repoManager,
      services.adapter,
      services.broker,
      services.storageRecoveryService,
      services.indexManager,
      services.recoveryManager,
      services.docStore,
      services.snapshotManager,
      syncedHeadsService,
      services.pullQueueManager,
      services.manifestSyncManager,
      services.orchestrator,
    ]

    for (const svc of lifecycleServices) {
      this.lifecycle.register({
        name: svc.lifecycleName,
        onStart: svc.onLifecycleStart?.bind(svc),
        onStop: svc.onLifecycleStop?.bind(svc),
      })
    }
  }

  private subscribeInternalEvents({ snapshotManager, recoveryManager, snapshotFormatUpgrade }: SyncWorkerServices): void {
    const unsub = this.internalEventHub.subscribe(event => {
      switch (event.type) {
        case 'leaderChange':
          snapshotManager.setLeader(event.isLeader)
          snapshotFormatUpgrade?.onLeaderChange(event.isLeader)
          break
        case 'decryptionFailure':
          fireAndForget(
            recoveryManager.reportDecryptionFailure(event.itemId, 'pullDecryption', event.error),
            'SyncWorkerContext:internalEvent:decryptionFailure',
          )
          break
        case 'localDecryptionFailed':
          fireAndForget(
            recoveryManager.reportDecryptionFailure(event.itemId, 'localDecryption', event.error),
            'SyncWorkerContext:internalEvent:localDecryptionFailed',
          )
          break
        case 'remoteMessagesParsed':
          fireAndForget(
            recoveryManager.resolveQuarantines([event.itemId], INBOUND_MESSAGE_RESOLVABLE_KINDS),
            'SyncWorkerContext:internalEvent:remoteMessagesParsed',
          )
          break
        case 'renegotiationTriggered': {
          const itemId = toVaultItemIdFromAutomergeId(event.documentId)
          snapshotManager.markItemDirty(itemId, 0)
          break
        }
        case 'walAppendFailed':
        case 'snapshotFallbackRequested':
          snapshotManager.markItemDirty(event.itemId, 0)
          break
        case 'walEntriesPruned':
          for (const itemId of event.itemIds) {
            snapshotManager.markItemDirty(itemId, 0)
          }
          break
      }
    })
    this.unsubscribers.push(unsub)
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
      return openLocalStorage({
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

  /**
   * Tells the app this device's local data can't be opened, with how many changes haven't been pushed
   * (the WAL's entry count, which needs no key), so it can offer recovery. The data is never reset here.
   */
  private async reportLocalDataUnavailable(error: LocalKeyUnavailableError | LocalDataUnreadableError): Promise<void> {
    let unpushedChanges = 0
    try {
      unpushedChanges = await SyncWriteAheadLog.getSealedStorage(this.accountId).length()
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
   * Runs `task` while holding the account's local data Web Lock, when the app migrates or seals local
   * data. Otherwise a tab could copy an old value over one another tab's engine has already written
   * since migrating, or two tabs could each create a device storage key.
   */
  private async withLocalDataLock<T>(task: () => Promise<T>): Promise<T> {
    const needsLock = this.config.migrateLocalData || this.config.upgradeLocalEncryption
    if (needsLock && typeof navigator !== 'undefined' && navigator?.locks?.request) {
      const lockName = `${getVaultStorageNames().accountPrefixes.localDataMigrationLock}${this.accountId}`
      return navigator.locks.request(lockName, { mode: 'exclusive' }, task)
    }
    return task()
  }

  async shutdown(options?: { clearLocalData?: boolean }): Promise<void> {
    this.isStopped = true
    this._services?.snapshotFormatUpgrade?.stop()
    this._services?.itemReencryptor.cancelScheduled()
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
   * left in place: it's replaced only when the user chooses to (see `replaceFromServer`).
   */
  private handleOpenFailure(key: string[], error: unknown): void {
    const [documentId] = key
    // The Repo's own storage ID record isn't a document
    if (key.length < 2 || this.unreadableDocuments.has(documentId)) return
    this.unreadableDocuments.add(documentId)
    const itemId = toVaultItemIdFromAutomergeId(documentId as DocumentId)
    this.internalEventHub.emit({ type: 'localDecryptionFailed', itemId, error })
  }

  /**
   * Replaces an item whose local copy can't be decrypted with the server's copy. Changes this device
   * hadn't pushed are lost, so the app asks first. The item stays quarantined if the server has no
   * copy to replace it with.
   */
  async replaceFromServer(itemId: ItemId): Promise<void> {
    const { repo, repoManager, manifestSyncManager, docStore, recoveryManager } = this.services
    const documentId = toDocumentIdFromItemId(itemId)
    // Drops the handle that never finished loading. Its chunks are removed here rather than left to
    // the Repo, which doesn't wait for that.
    repo.delete(documentId)
    await repoManager.getStorage()?.removeRange([documentId])
    this.unreadableDocuments.delete(documentId)

    // A forced sync fetches quarantined items, and there's no longer a local copy to keep
    const result = await manifestSyncManager.sync(true)
    if (!result.success || !(await docStore.hasDataInStorage(itemId))) {
      throw new Error(`The server's copy of ${itemId} could not be downloaded. Try again once sync has finished.`)
    }
    await recoveryManager.unquarantine(itemId)
  }

  async retrySave(): Promise<RetrySaveResult> {
    return this.services.storageRecoveryService.retrySave()
  }

  claimLeader(): void {
    this.services.orchestrator.claimLeader()
  }
}
