import type { Repo } from '@automerge/automerge-repo/slim'

import { AutomergeDocStore, AutomergeIndexManager, type DocHandleReplacedListener } from './docStore'
import { IndexStore } from './stores/IndexStore'
import { CursorStore } from './stores/CursorStore'
import { LastModifiedStore } from './stores/LastModifiedStore'
import { SyncedHeadsStore } from './stores/SyncedHeadsStore'
import { clearSyncMetadataStorage } from './stores/syncMetadataStorage'
import { SnapshotManager } from './SnapshotManager'
import { SyncOrchestrator } from './SyncOrchestrator'
import { ManifestSyncManager } from './ManifestSyncManager'
import { ItemOperations } from './ItemOperations'
import { RecoveryManager } from './RecoveryManager'
import { SyncMessageBroker } from './SyncMessageBroker'
import { VaultNetworkAdapter } from './VaultNetworkAdapter'
import { ClientEventHub, WorkerInternalEventHub } from './SyncEventHub'
import { SyncPullQueueManager } from './SyncPullQueueManager'
import { SyncWriteAheadLog } from './SyncWriteAheadLog'
import { AutomergeRepoManager } from './AutomergeRepoManager'
import { toDocumentIdFromItemId, toVaultItemIdFromAutomergeId, ACCOUNT_INDEX_DOCUMENT_ID } from './utils/automerge'
import type { ItemId } from 'src/shared/schemas/items'
import { ServiceLifecycleManager, type LifecycleAware } from './ServiceLifecycleManager'
import { SyncApiClient } from './SyncApiClient'
import { StorageRecoveryService, QuotaExceededRetryError } from './StorageRecoveryService'
import { ItemReencryptor } from './reencryptAllItems'

export { QuotaExceededRetryError }

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
  public readonly lifecycle = new ServiceLifecycleManager<{ clearLocalData?: boolean }>('SyncWorkerContext')

  private unsubscribers: Array<() => void> = []

  constructor(config: SyncWorkerContextConfig) {
    this.accountId = config.accountId
    this.clientEventHub = config.clientEventHub
    this.internalEventHub = config.internalEventHub
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
    this.manifestSyncManager = ops.manifestSyncManager
    this.storageRecoveryService = ops.storageRecoveryService
    this.itemReencryptor = new ItemReencryptor()
  }

  private wireEvents(): void {
    this.wireCrossServiceDependencies()
    this.registerLifecycleServices()
  }

  private initNetworkAndRepo(config: SyncWorkerContextConfig) {
    const adapter = new VaultNetworkAdapter(this.internalEventHub)
    const repoManager = new AutomergeRepoManager(config.accountId)
    const repo = repoManager.init(adapter, {
      onKeyVersionMissing: kver => config.clientEventHub.emit({ type: 'keyVersionMissing', kver }),
      onDocumentReceived: docId => {
        const itemId = toVaultItemIdFromAutomergeId(docId)
        if (itemId && (itemId as string) !== ACCOUNT_INDEX_DOCUMENT_ID) {
          config.onDocumentReceived?.(itemId)
        }
      },
      onQuotaError: error => {
        void this.storageRecoveryService?.handleQuotaExceeded(error)
      },
    })
    adapter.setSyncedHeadsStore?.(this.syncedHeadsStore)
    return { adapter, repoManager, repo }
  }

  private createCoreServices(config: SyncWorkerContextConfig) {
    const storage = this.repoManager.getStorage()
    const docStore = new AutomergeDocStore(this.repo, this.internalEventHub, storage)
    if (config.onDocHandleReplaced) {
      docStore.onDocHandleReplaced = config.onDocHandleReplaced
    }

    const indexManager = new AutomergeIndexManager(
      config.accountId,
      this.indexStore,
      itemIds => config.clientEventHub.emit({ type: 'indexUpdated', itemIds }),
      metadata => config.clientEventHub.emit({ type: 'metadataUpdated', metadata })
    )

    const pullQueueManager = new SyncPullQueueManager(
      this.cursorStore,
      docStore,
      this.internalEventHub
    )

    const broker = new SyncMessageBroker(
      this.adapter,
      config.clientEventHub,
      config.internalEventHub,
      indexManager,
      pullQueueManager,
      this.wal,
      null,
      this.apiClient,
    )

    const recoveryManager = new RecoveryManager({
      accountId: config.accountId,
      eventHub: config.clientEventHub,
    })

    const snapshotManager = new SnapshotManager(
      {
        accountId: config.accountId,
        repo: this.repo,
        broker,
        getLatestCursor: () => pullQueueManager.getGlobalLatestCursor(),
        eventHub: config.clientEventHub,
        recoveryManager,
        apiClient: this.apiClient,
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

    const itemOperations = new ItemOperations({
      accountId: config.accountId,
      docStore: this.docStore,
      indexManager: this.indexManager,
      eventHub: config.clientEventHub,
      markDocumentDirty: id => this.snapshotManager.markItemDirty(id),
      recoveryManager: this.recoveryManager,
      apiClient: this.apiClient,
    })

    const manifestSyncManager = new ManifestSyncManager({
      accountId: config.accountId,
      docStore: this.docStore,
      indexManager: this.indexManager,
      snapshotManager: this.snapshotManager,
      recoveryManager: this.recoveryManager,
      apiClient: this.apiClient,
      onKeyVersionMissing: kver => config.clientEventHub.emit({ type: 'keyVersionMissing', kver }),
      storeItems: (items, options) => itemOperations.storeItems(items, options),
      mutateMetadata: changes => itemOperations.mutateMetadata(changes),
      onDecryptionFailure: (itemId, error) => {
        void this.recoveryManager.reportDecryptionFailure(itemId, error)
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

    return { orchestrator, itemOperations, manifestSyncManager, storageRecoveryService }
  }

  private wireCrossServiceDependencies(): void {
    this.snapshotManager.setLeader(this.orchestrator.leader)
    this.orchestrator.setManifestSyncManager(this.manifestSyncManager)
    this.broker.setStorageRecoveryService?.(this.storageRecoveryService)
    this.subscribeInternalEvents()
  }

  private get storageCleanupService(): LifecycleAware<{ clearLocalData?: boolean }> {
    return {
      lifecycleName: 'StorageCleanup',
      onLifecycleStop: async options => {
        if (options?.clearLocalData) {
          await Promise.all([
            clearSyncMetadataStorage(this.accountId),
            this.indexStore.clear(),
            this.cursorStore.clear(),
            this.lastModifiedStore.clear(),
            this.wal.clear(),
            this.syncedHeadsStore.clear(),
          ])
        }
      },
    }
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
    const services: LifecycleAware<{ clearLocalData?: boolean }>[] = [
      this.storageCleanupService,
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
          break
        case 'decryptionFailure':
          void this.recoveryManager.reportDecryptionFailure(event.itemId, event.error)
          break
        case 'itemMessageParsed':
          void this.recoveryManager.unquarantineBatch([event.itemId])
          break
        case 'renegotiationTriggered': {
          const itemId = toVaultItemIdFromAutomergeId(event.documentId)
          this.snapshotManager.markItemDirty(itemId, 0)
          break
        }
        case 'walAppendFailed':
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
    await this.lifecycle.start()
  }

  async shutdown(options?: { clearLocalData?: boolean }): Promise<void> {
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
