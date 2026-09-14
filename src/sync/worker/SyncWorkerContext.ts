import type { Repo } from '@automerge/automerge-repo/slim'

import { AutomergeDocStore, type DocHandleReplacedListener } from './docStore'
import { AutomergeIndexManager } from './docStore/AutomergeIndexManager'
import { IndexStore } from './stores/IndexStore'
import { CursorStore } from './stores/CursorStore'
import { LastModifiedStore } from './stores/LastModifiedStore'
import { SyncedHeadsStore } from './stores/SyncedHeadsStore'
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
import { resetQuotaExceededStatus, registerQuotaRecoveryHandler } from '../../utils/storageManager'
import { isQuotaError } from '../../utils/storageQuota'
import { ServiceLifecycleManager } from './ServiceLifecycleManager'
import { SyncApiClient } from './SyncApiClient'

class QuotaExceededRetryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QuotaExceededRetryError'
  }
}

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
   * Called when the broker parses an inbound message for an item,
   * so the Comlink layer can ensure it is subscribed to that handle.
   */
  onItemMessageParsed?: (itemId: ItemId) => void
  /**
   * Called when the pull queue manager's retrying state changes,
   * so the Comlink layer can update the sync status manager.
   */
  onRetryingStateChange?: (isRetrying: boolean) => void
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
  public readonly lifecycle = new ServiceLifecycleManager<{ clearLocalData?: boolean }>('SyncWorkerContext')

  private unregisterQuotaRecovery: (() => void) | null = null

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
    this.wal = new SyncWriteAheadLog(config.accountId)

    // ── Network adapter & repo ─────────────────────────────────────────────
    this.adapter = new VaultNetworkAdapter()
    this.repoManager = new AutomergeRepoManager(config.accountId)
    this.repo = this.repoManager.init(this.adapter, {
      onKeyVersionMissing: kver => config.clientEventHub.emit({ type: 'keyVersionMissing', kver }),
      onDocumentReceived: docId => {
        const itemId = toVaultItemIdFromAutomergeId(docId)
        if (itemId && (itemId as string) !== ACCOUNT_INDEX_DOCUMENT_ID) {
          config.onDocumentReceived?.(itemId)
        }
      },
      onQuotaError: () => {
        config.clientEventHub.emit({
          type: 'quotaExceeded',
          message: 'Storage quota exceeded. Some changes could not be saved to this device.',
        })
      },
    })

    this.adapter.setSyncedHeadsStore?.(this.syncedHeadsStore)

    // ── Index manager ──────────────────────────────────────────────────────
    this.indexManager = new AutomergeIndexManager(
      config.accountId,
      this.indexStore,
      itemIds => config.clientEventHub.emit({ type: 'indexUpdated', itemIds }),
      metadata => config.clientEventHub.emit({ type: 'metadataUpdated', metadata })
    )

    // ── Pull queue ─────────────────────────────────────────────────────────
    this.pullQueueManager = new SyncPullQueueManager(this.cursorStore)
    this.pullQueueManager.onRetryingStateChange = isRetrying => {
      config.onRetryingStateChange?.(isRetrying)
    }
    this.pullQueueManager.onKeyVersionMissing = kver => {
      config.clientEventHub.emit({ type: 'keyVersionMissing', kver })
    }

    // ── Message broker ─────────────────────────────────────────────────────
    this.broker = new SyncMessageBroker(
      this.adapter,
      config.clientEventHub,
      config.internalEventHub,
      this.indexManager,
      this.pullQueueManager,
      this.wal
    )

    // ── Doc store ──────────────────────────────────────────────────────────
    this.docStore = new AutomergeDocStore(this.repo)
    if (config.onDocHandleReplaced) {
      this.docStore.onDocHandleReplaced = config.onDocHandleReplaced
    }
    this.pullQueueManager.setLockCoordinator?.(this.docStore)

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

    this.orchestrator.onLeaderChange = isLeader => {
      this.snapshotManager.setLeader(isLeader)
    }
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

    // ── Cross-component callback wiring ────────────────────────────────────
    this.pullQueueManager.onDecryptionFailure = (itemId, error) => {
      void this.itemOperations.reportDecryptionFailure(itemId, error)
    }

    this.pullQueueManager.onPendingPullsAvailable = () => {
      this.broker.onFlushNeeded?.()
    }

    this.broker.onItemMessageParsed = itemId => {
      void this.itemOperations.clearManualRecoveryForItems([itemId])
      config.onItemMessageParsed?.(itemId)
    }

    this.adapter.onReNegotiationTriggered = documentId => {
      const itemId = toVaultItemIdFromAutomergeId(documentId)
      this.snapshotManager.markItemDirty(itemId, 0)
    }

    this.broker.onWalAppendFailed = (itemId, _error) => {
      this.snapshotManager.markItemDirty(itemId, 0)
    }

    this.broker.onWalEntriesPruned = itemIds => {
      for (const itemId of itemIds) {
        this.snapshotManager.markItemDirty(itemId, 0)
      }
    }

    if (this.wal && !this.wal.onEntriesPruned) {
      this.wal.onEntriesPruned = itemIds => {
        for (const itemId of itemIds) {
          this.broker.markSnapshotOnly?.(itemId)
          this.snapshotManager.markItemDirty(itemId, 0)
        }
      }
    }

    // ── Manifest sync ──────────────────────────────────────────────────────
    this.manifestSyncManager = new ManifestSyncManager(
      {
        accountId: config.accountId,
        docStore: this.docStore,
        indexManager: this.indexManager,
        snapshotManager: this.snapshotManager,
        recoveryManager: this.recoveryManager,
        apiClient: this.apiClient,
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

    this.unregisterQuotaRecovery = registerQuotaRecoveryHandler(async () => {
      return this.wal.handleQuotaExceeded()
    })

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

    // 5. Quota recovery listener
    this.lifecycle.register({
      name: 'QuotaRecovery',
      onStop: () => {
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

  async initialize(): Promise<void> {
    await this.lifecycle.start()
  }

  async shutdown(options?: { clearLocalData?: boolean }): Promise<void> {
    await this.lifecycle.stop(options)
  }

  /**
   * Reacts to quota exceeded: triggers emergency compaction and notifies client.
   */
  async handleQuotaExceeded(error?: unknown): Promise<void> {
    console.warn('[SyncWorkerContext] Storage quota exceeded. Running emergency WAL compaction...', error)
    try {
      await this.wal.handleQuotaExceeded()
    } catch (compactionErr) {
      console.error('[SyncWorkerContext] Failed emergency compaction during quota handling:', compactionErr)
    }
    this.clientEventHub.emit({
      type: 'quotaExceeded',
      message: 'Storage quota exceeded. Flock cannot save changes or synchronize, risking data loss. Please free up space and check your connection to sync.',
    })
  }

  /**
   * Probes storage availability before attempting full persistence.
   */
  private async probeStorageAvailability(): Promise<void> {
    try {
      await this.lastModifiedStore.testStorageAvailable()
    } catch (probeErr) {
      if (isQuotaError(probeErr)) {
        throw new QuotaExceededRetryError(
          'Storage quota is still exceeded. Please free up more space on your device.'
        )
      }
      throw probeErr
    }
  }

  /**
   * Resets broker and network renegotiation circuits once storage is available.
   */
  private resetStorageCircuits(): void {
    this.broker.unblockAllItems?.()
    this.adapter.resetReNegotiationCircuit?.()
  }

  /**
   * Persists dirty Automerge documents to local IndexedDB storage.
   */
  private async persistDirtyDocuments(dirtyIds: ItemId[]): Promise<void> {
    for (const itemId of dirtyIds) {
      try {
        await this.docStore.saveDocToStorage(itemId)
      } catch (saveErr) {
        if (isQuotaError(saveErr)) {
          throw new QuotaExceededRetryError('Storage quota is still exceeded while saving documents.')
        }
        console.warn(`[SyncWorkerContext] Failed to save doc for item ${itemId} during retrySave`, saveErr)
      }
    }
  }

  /**
   * Triggers Automerge renegotiation so sync messages are queued into the WAL.
   */
  private triggerRenegotiations(dirtyIds: ItemId[]): void {
    for (const itemId of dirtyIds) {
      const documentId = toDocumentIdFromItemId(itemId)
      this.adapter.triggerReNegotiation?.(documentId)
    }
  }

  /**
   * Persists timestamps metadata.
   */
  private async persistTimestamps(): Promise<void> {
    try {
      await this.snapshotManager.persistLastModified()
    } catch (tsErr) {
      if (isQuotaError(tsErr)) {
        throw new QuotaExceededRetryError('Storage quota is still exceeded while saving timestamps.')
      }
      throw tsErr
    }
  }

  /**
   * If online, flushes pending snapshots and triggers orchestrator sync.
   */
  private flushPendingSyncIfOnline(): void {
    if (this.orchestrator.online) {
      void this.snapshotManager.flushPendingSnapshots().catch(console.error)
      this.orchestrator.flush()
    }
  }

  /**
   * Resets global quota status and notifies client.
   */
  private resolveQuotaStatus(): void {
    resetQuotaExceededStatus()
    this.clientEventHub.emit({ type: 'quotaResolved' })
  }

  async retrySave(): Promise<{ success: boolean; error?: string }> {
    try {
      await this.probeStorageAvailability()
      this.resetStorageCircuits()

      const dirtyIds = this.snapshotManager.getDirtyItemIds()
      await this.persistDirtyDocuments(dirtyIds)
      this.triggerRenegotiations(dirtyIds)

      await this.persistTimestamps()
      this.flushPendingSyncIfOnline()

      this.resolveQuotaStatus()
      return { success: true }
    } catch (err) {
      if (err instanceof QuotaExceededRetryError) {
        return { success: false, error: err.message }
      }
      console.error('[SyncWorkerContext] Unexpected error during retrySave', err)
      return { success: false, error: (err as Error).message || 'Failed to retry save' }
    }
  }

  claimLeader(): void {
    this.orchestrator.claimLeader()
  }
}
