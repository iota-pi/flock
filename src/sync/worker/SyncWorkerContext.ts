import type { Repo, DocHandle } from '@automerge/automerge-repo/slim'
import * as Automerge from '@automerge/automerge/slim'

import { AutomergeDocStore, AutomergeIndexManager, type DocHandleReplacedListener } from './docStore'
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
import { toDocumentIdFromItemId, toVaultItemIdFromAutomergeId, ACCOUNT_INDEX_DOCUMENT_ID } from './utils/automerge'
import type { ItemId } from 'src/shared/vault/ids'
import { ServiceLifecycleManager, type LifecycleAware } from './ServiceLifecycleManager'
import { SyncApiClient } from './SyncApiClient'
import { StorageRecoveryService } from './StorageRecoveryService'
import { ItemReencryptor } from './reencryptAllItems'
import { SnapshotFormatUpgrade } from './SnapshotFormatUpgrade'
import { DataVersionTracker } from './DataVersionTracker'
import { fireAndForget } from '../utils/fireAndForget'
import { publishRealtimeBusItemDirty, subscribeRealtimeBusItemDirty } from './realtimeBus'
import { DEFAULT_SYNC_DOMAIN, type SyncDomain } from './domain'
import { AccountSettings, withSettingsDocPassthrough } from './AccountSettings'
import { getVaultStorageNames } from '../shared/storageNames'
import type { KeyProvider } from '../../api/vault/Keyring'

/**
 * Slim configuration for SyncWorkerContext.
 * All stores and managers are constructed internally; only primitive inputs and
 * optional callback bridges back to the Comlink layer are accepted here.
 */
export interface SyncWorkerContextConfig {
  accountId: string
  clientEventHub: ClientEventHub
  internalEventHub: WorkerInternalEventHub
  /**
   * Called when the Automerge repo receives a new document from the network,
   * so the Comlink layer can subscribe to change events on that handle.
   */
  onDocumentReceived?: (itemId: ItemId) => void
  /** Called when a doc handle is replaced (e.g. after compaction/import). */
  onDocHandleReplaced?: DocHandleReplacedListener
  /**
   * Called with every indexed document ID, including the settings document, which the
   * `indexUpdated` event sent to the app leaves out.
   */
  onIndexUpdated?: (itemIds: ItemId[]) => void
  /**
   * Called when storage quota state changes (exceeded / resolved).
   */
  onQuotaStatusChange?: (isQuotaExceeded: boolean) => void
  /**
   * Called when an inbound item sync message has been parsed.
   */
  onItemMessageParsed?: (itemId: ItemId) => void
  /** Optional callback to refresh the authentication token with the main thread. */
  refreshAuthToken?: () => Promise<string | null>
  /** Optional override for testing. */
  apiClient?: SyncApiClient
  /** The app's document codec and hooks. Defaults to passing documents through untouched. */
  domain?: SyncDomain
  /** Brings local data from older layouts into the current one (see SyncWorkerConfig) */
  migrateLocalData?: (accountId: string) => Promise<void>
  /** The account's data keys */
  keys: KeyProvider
}

export class SyncWorkerContext {
  public readonly accountId: string
  public repo!: Repo
  public adapter!: VaultNetworkAdapter
  public broker!: SyncMessageBroker
  public repoManager!: AutomergeRepoManager
  public readonly clientEventHub: ClientEventHub
  public readonly internalEventHub: WorkerInternalEventHub
  public readonly apiClient: SyncApiClient
  public readonly domain: SyncDomain

  public indexStore!: IndexStore
  public cursorStore!: CursorStore
  public lastModifiedStore!: LastModifiedStore
  public syncedHeadsStore!: SyncedHeadsStore
  public wal!: SyncWriteAheadLog

  public docStore!: AutomergeDocStore
  public indexManager!: AutomergeIndexManager
  public recoveryManager!: RecoveryManager
  public pullQueueManager!: SyncPullQueueManager
  public snapshotManager!: SnapshotManager
  public orchestrator!: SyncOrchestrator
  public manifestSyncManager!: ManifestSyncManager
  public itemOperations!: ItemOperations
  public storageRecoveryService!: StorageRecoveryService
  public itemReencryptor!: ItemReencryptor
  public accountSettings!: AccountSettings
  public snapshotFormatUpgrade!: SnapshotFormatUpgrade
  public dataVersionTracker!: DataVersionTracker
  public readonly lifecycle = new ServiceLifecycleManager<{ clearLocalData?: boolean }>('SyncWorkerContext')

  private unsubscribers: Array<() => void> = []
  private readonly migrateLocalDataHook?: (accountId: string) => Promise<void>

  constructor(config: SyncWorkerContextConfig) {
    this.accountId = config.accountId
    this.migrateLocalDataHook = config.migrateLocalData
    this.clientEventHub = config.clientEventHub
    this.internalEventHub = config.internalEventHub
    const domain = config.domain ?? DEFAULT_SYNC_DOMAIN
    this.domain = { ...domain, codec: withSettingsDocPassthrough(domain.codec, config.accountId) }
    this.apiClient = config.apiClient ?? new SyncApiClient({
      refreshAuthToken: config.refreshAuthToken,
    })

    this.initStores(config.accountId)
    this.initServices(config)
    this.wireEvents()
  }

  private initStores(accountId: string): void {
    this.cursorStore = new CursorStore(accountId)
    this.indexStore = new IndexStore(accountId)
    this.lastModifiedStore = new LastModifiedStore(accountId)
    this.syncedHeadsStore = new SyncedHeadsStore(accountId)
    this.wal = new SyncWriteAheadLog(accountId, this.internalEventHub)
  }

  private initServices(config: SyncWorkerContextConfig): void {
    const network = this.initNetworkAndRepo(config)
    this.adapter = network.adapter
    this.repoManager = network.repoManager
    this.repo = network.repo

    const core = this.createCoreServices(config)
    this.docStore = core.docStore
    this.indexManager = core.indexManager
    this.pullQueueManager = core.pullQueueManager
    this.broker = core.broker
    this.recoveryManager = core.recoveryManager
    this.snapshotManager = core.snapshotManager

    const ops = this.createOrchestrationAndOperations(config)
    this.orchestrator = ops.orchestrator
    this.itemOperations = ops.itemOperations
    this.accountSettings = ops.accountSettings
    this.manifestSyncManager = ops.manifestSyncManager
    this.storageRecoveryService = ops.storageRecoveryService
    this.itemReencryptor = new ItemReencryptor({ codec: this.domain.codec, keys: config.keys })
    this.dataVersionTracker = new DataVersionTracker({
      accountId: config.accountId,
      dataVersion: this.domain.dataVersion ?? 0,
      raiseAccountDataVersion: () => this.apiClient.raiseDataVersion({ account: config.accountId }),
    })
    this.snapshotFormatUpgrade = new SnapshotFormatUpgrade({
      accountId: config.accountId,
      onUpgraded: () => fireAndForget(
        this.dataVersionTracker.onSnapshotsUpgraded(),
        'SyncWorkerContext:raiseAccountDataVersion',
      ),
      rewriteSnapshots: signal => this.itemReencryptor.reencryptAllItems({
        accountId: config.accountId,
        signal,
        repo: this.repo,
        indexManager: this.indexManager,
        apiClient: this.apiClient,
        recoveryManager: this.recoveryManager,
        reencryptor: this.itemReencryptor,
      }),
    })
  }

  private wireEvents(): void {
    this.wireCrossServiceDependencies()
    this.registerLifecycleServices()
  }

  private initNetworkAndRepo(config: SyncWorkerContextConfig) {
    const adapter = new VaultNetworkAdapter(this.internalEventHub)
    const repoManager = new AutomergeRepoManager(config.accountId, config.keys)
    const repo = repoManager.init(adapter, {
      onKeyVersionMissing: kver => config.clientEventHub.emit({ type: 'keyVersionMissing', kver }),
      onDocumentReceived: docId => {
        const itemId = toVaultItemIdFromAutomergeId(docId)
        if (itemId && (itemId as string) !== ACCOUNT_INDEX_DOCUMENT_ID) {
          config.onDocumentReceived?.(itemId)
        }
      },
      onQuotaError: error => {
        if (this.storageRecoveryService) {
          fireAndForget(this.storageRecoveryService.handleQuotaExceeded(error), 'SyncWorkerContext:onQuotaError')
        }
      },
    })
    adapter.setSyncedHeadsStore?.(this.syncedHeadsStore)
    adapter.setHeadsValidator?.((documentId, heads) => {
      const handle = repo.handles[documentId] as DocHandle<unknown> | undefined
      if (!handle?.isReady()) return false
      const doc = handle.doc()
      return doc ? Automerge.hasHeads(doc, heads) : false
    })
    return { adapter, repoManager, repo }
  }

  private createCoreServices(config: SyncWorkerContextConfig) {
    const storage = this.repoManager.getStorage()
    const docStore = new AutomergeDocStore(this.repo, this.internalEventHub, storage, this.domain.codec)
    if (config.onDocHandleReplaced) {
      docStore.onDocHandleReplaced = config.onDocHandleReplaced
    }

    const indexManager = new AutomergeIndexManager(
      config.accountId,
      this.indexStore,
      itemIds => {
        config.onIndexUpdated?.(itemIds)
        const settingsId = this.accountSettings?.docId
        config.clientEventHub.emit({ type: 'indexUpdated', itemIds: itemIds.filter(id => id !== settingsId) })
      },
      metadata => this.accountSettings?.handleLocalMetadata(metadata),
    )

    const pullQueueManager = new SyncPullQueueManager(
      this.cursorStore,
      config.keys,
      docStore,
      this.internalEventHub
    )

    const recoveryManager = new RecoveryManager({
      accountId: config.accountId,
      eventHub: config.clientEventHub,
    })

    const broker = new SyncMessageBroker(
      this.adapter,
      config.clientEventHub,
      config.internalEventHub,
      indexManager,
      pullQueueManager,
      config.keys,
      this.wal,
      null,
      this.apiClient,
      recoveryManager,
    )

    const snapshotManager = new SnapshotManager(
      {
        accountId: config.accountId,
        repo: this.repo,
        broker,
        getLatestCursor: () => pullQueueManager.getGlobalLatestCursor(),
        eventHub: config.clientEventHub,
        recoveryManager,
        apiClient: this.apiClient,
        codec: this.domain.codec,
        keys: config.keys,
      },
      this.lastModifiedStore
    )

    return { docStore, indexManager, pullQueueManager, broker, recoveryManager, snapshotManager }
  }

  private createOrchestrationAndOperations(config: SyncWorkerContextConfig) {
    const orchestrator = new SyncOrchestrator(
      config.accountId,
      this.broker,
      config.clientEventHub,
      config.internalEventHub,
      this.pullQueueManager
    )

    const markDocumentDirty = (id: ItemId) => {
      this.snapshotManager.markItemDirty(id)
      // Only the leader uploads snapshots, so tell it about edits made in this tab
      publishRealtimeBusItemDirty(config.accountId, [id])
    }

    const itemOperations = new ItemOperations({
      accountId: config.accountId,
      docStore: this.docStore,
      indexManager: this.indexManager,
      eventHub: config.clientEventHub,
      markDocumentDirty,
      recoveryManager: this.recoveryManager,
      hooks: this.domain.hooks,
    })

    const accountSettings = new AccountSettings({
      accountId: config.accountId,
      docStore: this.docStore,
      indexManager: this.indexManager,
      eventHub: config.clientEventHub,
      markDocumentDirty,
      syncedKeys: this.domain.syncedMetadataKeys,
      legacySettings: this.domain.legacySettings,
      withAuth: request => this.apiClient.executeWithAuth(() => request()),
    })

    const manifestSyncManager = new ManifestSyncManager({
      accountId: config.accountId,
      docStore: this.docStore,
      indexManager: this.indexManager,
      snapshotManager: this.snapshotManager,
      keys: config.keys,
      recoveryManager: this.recoveryManager,
      apiClient: this.apiClient,
      onKeyVersionMissing: kver => config.clientEventHub.emit({ type: 'keyVersionMissing', kver }),
      storeItems: (items, options) => itemOperations.storeItems(items, options),
      decodeLegacyItem: this.domain.decodeLegacyItem,
      migrateLegacySettings: () => accountSettings.migrateLegacySettings(),
      onSyncedWithoutFailures: () => {
        this.snapshotFormatUpgrade.onSyncedWithoutFailures()
        fireAndForget(this.dataVersionTracker.onSyncedWithoutFailures(), 'SyncWorkerContext:recordDeviceDataVersion')
      },
      onDecryptionFailure: (itemId, error) => {
        fireAndForget(this.recoveryManager.reportDecryptionFailure(itemId, 'snapshotDecryption', error), 'SyncWorkerContext:reportDecryptionFailure')
      },
      onItemSnapshotHydrated: (itemId, heads) => {
        const docId = toDocumentIdFromItemId(itemId)
        this.adapter.setSyncedHeads(docId, heads)
      },
    })

    const storageRecoveryService = new StorageRecoveryService({
      accountId: config.accountId,
      clientEventHub: config.clientEventHub,
      wal: this.wal,
      docStore: this.docStore,
      snapshotManager: this.snapshotManager,
      lastModifiedStore: this.lastModifiedStore,
      broker: this.broker,
      adapter: this.adapter,
      orchestrator,
      onQuotaStatusChange: config.onQuotaStatusChange,
    })

    return { orchestrator, itemOperations, accountSettings, manifestSyncManager, storageRecoveryService }
  }

  private wireCrossServiceDependencies(): void {
    this.snapshotManager.setLeader(this.orchestrator.leader)
    this.orchestrator.setManifestSyncManager(this.manifestSyncManager)
    this.broker.setStorageRecoveryService(this.storageRecoveryService)
    this.broker.setRecoveryManager(this.recoveryManager)
    this.subscribeInternalEvents()
    this.subscribeCrossTabDirtyItems()
  }

  private subscribeCrossTabDirtyItems(): void {
    const unsub = subscribeRealtimeBusItemDirty(this.accountId, itemIds => {
      for (const itemId of itemIds) {
        this.snapshotManager.markItemDirty(itemId)
      }
    })
    this.unsubscribers.push(unsub)
  }

  private get syncedHeadsService(): LifecycleAware {
    return {
      lifecycleName: 'SyncedHeads',
      onLifecycleStart: async () => {
        const storedHeads = await this.syncedHeadsStore.loadSyncedHeads()
        if (storedHeads && storedHeads.length > 0) {
          this.adapter.loadSyncedHeads(storedHeads)
        }
      },
    }
  }

  private registerLifecycleServices(): void {
    // Teardown runs in LIFO order (reverse registration order).
    // Startup runs in FIFO order (registration order).
    // Register items that should stop last first, and items that should stop first last.
    //
    // Note: Local storage clearing during account logout is handled exclusively by the
    // main thread (clearAccountLocalData in localDataCleanup.ts) after the worker has cleanly
    // closed all connections. The worker must not attempt to clear databases on shutdown.
    const services: LifecycleAware<{ clearLocalData?: boolean }>[] = [
      this.repoManager,
      this.adapter,
      this.broker,
      this.storageRecoveryService,
      this.indexManager,
      this.recoveryManager,
      this.docStore,
      this.snapshotManager,
      this.syncedHeadsService,
      this.pullQueueManager,
      this.manifestSyncManager,
      this.orchestrator,
    ]

    for (const svc of services) {
      this.lifecycle.register({
        name: svc.lifecycleName,
        onStart: svc.onLifecycleStart?.bind(svc),
        onStop: svc.onLifecycleStop?.bind(svc),
      })
    }
  }

  private subscribeInternalEvents(): void {
    const unsub = this.internalEventHub.subscribe(event => {
      switch (event.type) {
        case 'leaderChange':
          this.snapshotManager.setLeader(event.isLeader)
          this.snapshotFormatUpgrade.onLeaderChange(event.isLeader)
          break
        case 'decryptionFailure':
          fireAndForget(
            this.recoveryManager.reportDecryptionFailure(event.itemId, 'pullDecryption', event.error),
            'SyncWorkerContext:internalEvent:decryptionFailure',
          )
          break
        case 'remoteMessagesParsed':
          fireAndForget(
            this.recoveryManager.resolveQuarantines([event.itemId], INBOUND_MESSAGE_RESOLVABLE_KINDS),
            'SyncWorkerContext:internalEvent:remoteMessagesParsed',
          )
          break
        case 'renegotiationTriggered': {
          const itemId = toVaultItemIdFromAutomergeId(event.documentId)
          this.snapshotManager.markItemDirty(itemId, 0)
          break
        }
        case 'walAppendFailed':
        case 'snapshotFallbackRequested':
          this.snapshotManager.markItemDirty(event.itemId, 0)
          break
        case 'walEntriesPruned':
          for (const itemId of event.itemIds) {
            this.snapshotManager.markItemDirty(itemId, 0)
          }
          break
      }
    })
    this.unsubscribers.push(unsub)
  }

  async initialize(): Promise<void> {
    // Stores only read the current layout, so this runs first. A failure must stop initialization:
    // starting would create an empty index, and a later migration would then keep it over the old one.
    await this.migrateLocalData()
    // Checked before starting, which creates an empty index for a new device
    const hasLocalData = (await this.indexStore.getIndex()) !== null
    await this.lifecycle.start()
    await this.accountSettings.load()
    fireAndForget(this.dataVersionTracker.onStart(hasLocalData), 'SyncWorkerContext:recordDeviceDataVersion')
  }

  /**
   * Runs the app's local data migration while holding a per-account Web Lock. Otherwise a tab could
   * copy an old value over one another tab's engine has already written since migrating.
   */
  private async migrateLocalData(): Promise<void> {
    const migrate = this.migrateLocalDataHook
    if (!migrate) return
    if (typeof navigator !== 'undefined' && navigator?.locks?.request) {
      const lockName = `${getVaultStorageNames().accountPrefixes.localDataMigrationLock}${this.accountId}`
      await navigator.locks.request(lockName, { mode: 'exclusive' }, () => migrate(this.accountId))
      return
    }
    await migrate(this.accountId)
  }

  async shutdown(options?: { clearLocalData?: boolean }): Promise<void> {
    this.snapshotFormatUpgrade?.stop()
    this.itemReencryptor?.cancelScheduled()
    await this.lifecycle.stop(options)
    for (const unsub of this.unsubscribers) {
      unsub()
    }
    this.unsubscribers = []
  }

  /**
   * Reacts to quota exceeded: triggers emergency compaction and notifies client.
   */
  async handleQuotaExceeded(error?: unknown): Promise<void> {
    return this.storageRecoveryService.handleQuotaExceeded(error)
  }

  async retrySave(): Promise<{ success: boolean; error?: string }> {
    return this.storageRecoveryService.retrySave()
  }

  claimLeader(): void {
    this.orchestrator.claimLeader()
  }
}
