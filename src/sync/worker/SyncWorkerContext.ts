import type { Repo } from '@automerge/automerge-repo/slim'

import { AutomergeDocStore, type DocHandleReplacedListener } from './docStore'
import { AutomergeIndexManager } from './docStore/AutomergeIndexManager'
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
import { VaultNetworkAdapter } from './VaultEncryptedNetworkAdapter'
import { ClientEventHub, WorkerInternalEventHub } from './SyncEventHub'
import { SyncPullQueueManager } from './SyncPullQueueManager'
import { SyncWriteAheadLog } from './SyncWriteAheadLog'
import { AutomergeRepoManager } from './AutomergeRepoManager'
import { toDocumentIdFromItemId, toVaultItemIdFromAutomergeId, ACCOUNT_INDEX_DOCUMENT_ID } from './utils/automerge'
import type { ItemId } from 'src/shared/schemas/items'
import { ServiceLifecycleManager } from './ServiceLifecycleManager'
import { SyncApiClient } from './SyncApiClient'
import { StorageRecoveryService, QuotaExceededRetryError } from './StorageRecoveryService'

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
  /** Optional override for testing. */
  apiClient?: SyncApiClient
}

export class SyncWorkerContext {
  public readonly accountId: string
  public readonly repo: Repo
  public readonly adapter: VaultNetworkAdapter
  public readonly broker: SyncMessageBroker
  public readonly repoManager: AutomergeRepoManager
  public readonly clientEventHub: ClientEventHub
  public readonly internalEventHub: WorkerInternalEventHub
  public readonly apiClient: SyncApiClient

  public readonly indexStore: IndexStore
  public readonly cursorStore: CursorStore
  public readonly lastModifiedStore: LastModifiedStore
  public readonly syncedHeadsStore: SyncedHeadsStore
  public readonly wal: SyncWriteAheadLog

  public readonly docStore: AutomergeDocStore
  public readonly indexManager: AutomergeIndexManager
  public readonly recoveryManager: RecoveryManager
  public readonly pullQueueManager: SyncPullQueueManager
  public readonly snapshotManager: SnapshotManager
  public readonly orchestrator: SyncOrchestrator
  public readonly manifestSyncManager: ManifestSyncManager
  public readonly itemOperations: ItemOperations
  public readonly storageRecoveryService: StorageRecoveryService
  public readonly lifecycle = new ServiceLifecycleManager<{ clearLocalData?: boolean }>('SyncWorkerContext')

  public get storageRecovery(): StorageRecoveryService {
    return this.storageRecoveryService
  }

  private unregisterQuotaRecovery: (() => void) | null = null
  private unsubscribers: Array<() => void> = []

  constructor(config: SyncWorkerContextConfig) {
    this.accountId = config.accountId
    this.clientEventHub = config.clientEventHub
    this.internalEventHub = config.internalEventHub
    this.apiClient = config.apiClient ?? new SyncApiClient()

    // ── Stores ────────────────────────────────────────────────────────────
    this.cursorStore = new CursorStore(config.accountId)
    this.indexStore = new IndexStore(config.accountId)
    this.lastModifiedStore = new LastModifiedStore(config.accountId)
    this.syncedHeadsStore = new SyncedHeadsStore(config.accountId)
    this.wal = new SyncWriteAheadLog(config.accountId, this.internalEventHub)

    // ── Network adapter & repo ─────────────────────────────────────────────
    this.adapter = new VaultNetworkAdapter(this.internalEventHub)
    this.repoManager = new AutomergeRepoManager(config.accountId)
    this.repo = this.repoManager.init(this.adapter, {
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

    this.adapter.setSyncedHeadsStore?.(this.syncedHeadsStore)

    // ── Doc store ──────────────────────────────────────────────────────────
    this.docStore = new AutomergeDocStore(this.repo, this.internalEventHub)
    if (config.onDocHandleReplaced) {
      this.docStore.onDocHandleReplaced = config.onDocHandleReplaced
    }

    // ── Index manager ──────────────────────────────────────────────────────
    this.indexManager = new AutomergeIndexManager(
      config.accountId,
      this.indexStore,
      itemIds => config.clientEventHub.emit({ type: 'indexUpdated', itemIds }),
      metadata => config.clientEventHub.emit({ type: 'metadataUpdated', metadata })
    )

    // ── Pull queue ─────────────────────────────────────────────────────────
    this.pullQueueManager = new SyncPullQueueManager(
      this.cursorStore,
      this.docStore,
      this.internalEventHub,
    )

    // ── Message broker ─────────────────────────────────────────────────────
    this.broker = new SyncMessageBroker(
      this.adapter,
      config.clientEventHub,
      config.internalEventHub,
      this.indexManager,
      this.pullQueueManager,
      this.wal
    )

    // ── Recovery & snapshot ────────────────────────────────────────────────
    this.recoveryManager = new RecoveryManager({
      accountId: config.accountId,
      eventHub: config.clientEventHub,
    })

    this.snapshotManager = new SnapshotManager(
      {
        accountId: config.accountId,
        repo: this.repo,
        broker: this.broker,
        getLatestCursor: () => this.pullQueueManager.getGlobalLatestCursor(),
        eventHub: config.clientEventHub,
        recoveryManager: this.recoveryManager,
        apiClient: this.apiClient,
      },
      this.lastModifiedStore
    )

    // ── Orchestrator ───────────────────────────────────────────────────────
    this.orchestrator = new SyncOrchestrator(
      config.accountId,
      this.broker,
      config.clientEventHub,
      config.internalEventHub,
      this.pullQueueManager
    )

    this.snapshotManager.setLeader(this.orchestrator.leader)

    // ── Item operations ────────────────────────────────────────────────────
    this.itemOperations = new ItemOperations({
      accountId: config.accountId,
      docStore: this.docStore,
      indexManager: this.indexManager,
      eventHub: config.clientEventHub,
      markDocumentDirty: id => this.snapshotManager.markItemDirty(id),
      recoveryManager: this.recoveryManager,
    })

    this.subscribeInternalEvents(config)

    // ── Manifest sync ──────────────────────────────────────────────────────
    this.manifestSyncManager = new ManifestSyncManager(
      {
        accountId: config.accountId,
        docStore: this.docStore,
        indexManager: this.indexManager,
        snapshotManager: this.snapshotManager,
        recoveryManager: this.recoveryManager,
        apiClient: this.apiClient,
        onKeyVersionMissing: kver => config.clientEventHub.emit({ type: 'keyVersionMissing', kver }),
      },
      (items, options) => this.itemOperations.storeItems(items, options),
      changes => this.itemOperations.mutateMetadata(changes),
      (itemId, error) => {
        void this.itemOperations.reportDecryptionFailure(itemId, error)
      },
      (itemId, heads) => {
        const docId = toDocumentIdFromItemId(itemId)
        this.adapter.setSyncedHeads(docId, heads)
      },
    )

    this.orchestrator.setManifestSyncManager(this.manifestSyncManager)

    this.storageRecoveryService = new StorageRecoveryService({
      accountId: config.accountId,
      clientEventHub: config.clientEventHub,
      wal: this.wal,
      docStore: this.docStore,
      snapshotManager: this.snapshotManager,
      lastModifiedStore: this.lastModifiedStore,
      broker: this.broker,
      adapter: this.adapter,
      orchestrator: this.orchestrator,
      onQuotaStatusChange: config.onQuotaStatusChange,
    })
    this.broker.setStorageRecoveryService?.(this.storageRecoveryService)

    this.registerLifecycleServices()
  }

  private registerLifecycleServices(): void {
    // Teardown runs in LIFO order (reverse registration order).
    // Startup runs in FIFO order (registration order).
    // Register items that should stop last first, and items that should stop first last.

    // 1. Storage cleanup on logout/clearLocalData (runs last on teardown)
    this.lifecycle.register({
      name: 'StorageCleanup',
      onStop: async options => {
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
    })

    // 2. RepoManager — close IndexedDB last (after all doc operations)
    this.lifecycle.register({
      name: 'RepoManager',
      onStop: async options => {
        if (options?.clearLocalData) {
          try {
            await this.repoManager.clearLocalData()
          } catch (err) {
            console.error('[SyncWorkerContext] Error clearing Automerge DB', err)
          }
        }
        await this.repoManager.close()
      },
    })

    // 3. VaultNetworkAdapter
    this.lifecycle.register({
      name: 'VaultNetworkAdapter',
      onStop: () => {
        this.adapter.disconnect()
      },
    })

    // 4. SyncMessageBroker
    this.lifecycle.register({
      name: 'SyncMessageBroker',
      onStop: async () => {
        await this.broker.shutdown()
      },
    })

    // 5. StorageRecoveryService
    this.lifecycle.register({
      name: 'StorageRecoveryService',
      onStart: () => {
        this.storageRecoveryService.start()
      },
      onStop: () => {
        this.storageRecoveryService.stop()
        if (this.unregisterQuotaRecovery) {
          this.unregisterQuotaRecovery()
          this.unregisterQuotaRecovery = null
        }
      },
    })

    // 6. IndexManager
    this.lifecycle.register({
      name: 'IndexManager',
      onStart: async () => {
        await this.indexManager.ensureIndexDocument()
      },
      onStop: () => {
        this.indexManager.close?.()
      },
    })

    // 7. ItemOperations
    this.lifecycle.register({
      name: 'ItemOperations',
      onStop: () => {
        this.itemOperations.resetRecoveryState()
      },
    })

    // 8. DocStore
    this.lifecycle.register({
      name: 'DocStore',
      onStop: async () => {
        await this.docStore.shutdown()
      },
    })

    // 9. SnapshotManager
    this.lifecycle.register({
      name: 'SnapshotManager',
      onStart: async () => {
        await this.snapshotManager.loadLastModified()
      },
      onStop: async options => {
        await this.snapshotManager.shutdown(options)
      },
    })

    // 10. SyncedHeads
    this.lifecycle.register({
      name: 'SyncedHeads',
      onStart: async () => {
        const storedHeads = await this.syncedHeadsStore.loadSyncedHeads()
        if (storedHeads && storedHeads.length > 0) {
          this.adapter.loadSyncedHeads(storedHeads)
        }
      },
    })

    // 11. PullQueueManager
    this.lifecycle.register({
      name: 'PullQueueManager',
      onStop: async options => {
        await this.pullQueueManager.shutdown(options)
      },
    })

    // 12. ManifestSyncManager
    this.lifecycle.register({
      name: 'ManifestSyncManager',
      onStop: () => {
        this.manifestSyncManager.shutdown()
      },
    })

    // 13. SyncOrchestrator (starts last, stops first)
    this.lifecycle.register({
      name: 'SyncOrchestrator',
      onStart: async () => {
        await this.orchestrator.start()
      },
      onStop: async () => {
        await this.orchestrator.shutdown()
      },
    })
  }

  private subscribeInternalEvents(config: SyncWorkerContextConfig): void {
    const unsub = this.internalEventHub.subscribe(event => {
      switch (event.type) {
        case 'leaderChange':
          this.snapshotManager.setLeader(event.isLeader)
          break
        case 'decryptionFailure':
          void this.itemOperations.reportDecryptionFailure(event.itemId, event.error)
          break
        case 'itemMessageParsed':
          void this.itemOperations.clearManualRecoveryForItems([event.itemId])
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
