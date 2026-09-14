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
import { toDocumentIdFromItemId, toVaultItemIdFromAutomergeId } from './utils/automerge'
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

export interface SyncWorkerContextDeps {
  accountId: string
  repo: Repo
  adapter: VaultNetworkAdapter
  broker: SyncMessageBroker
  clientEventHub: ClientEventHub
  internalEventHub: WorkerInternalEventHub
  indexStore: IndexStore
  indexManager: AutomergeIndexManager
  cursorStore: CursorStore
  pullQueueManager: SyncPullQueueManager
  wal?: SyncWriteAheadLog
  syncedHeadsStore?: SyncedHeadsStore
  onDocHandleReplaced?: DocHandleReplacedListener
  onItemMessageParsed?: (itemId: ItemId) => void
  apiClient?: SyncApiClient
}

export class SyncWorkerContext {
  public readonly accountId: string
  public readonly repo: Repo
  public readonly adapter: VaultNetworkAdapter
  public readonly broker: SyncMessageBroker
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

  constructor(deps: SyncWorkerContextDeps) {
    this.accountId = deps.accountId
    this.repo = deps.repo
    this.adapter = deps.adapter
    this.broker = deps.broker
    this.clientEventHub = deps.clientEventHub
    this.internalEventHub = deps.internalEventHub
    this.apiClient = deps.apiClient ?? new SyncApiClient()

    this.indexStore = deps.indexStore
    this.indexManager = deps.indexManager
    this.cursorStore = deps.cursorStore
    this.pullQueueManager = deps.pullQueueManager
    this.lastModifiedStore = new LastModifiedStore(deps.accountId)
    this.syncedHeadsStore = deps.syncedHeadsStore ?? new SyncedHeadsStore(deps.accountId)
    this.adapter.setSyncedHeadsStore?.(this.syncedHeadsStore)
    this.wal = deps.wal ?? deps.broker.getWal?.() ?? new SyncWriteAheadLog(deps.accountId)

    this.docStore = new AutomergeDocStore(deps.repo)
    if (deps.onDocHandleReplaced) {
      this.docStore.onDocHandleReplaced = deps.onDocHandleReplaced
    }
    this.pullQueueManager.setLockCoordinator?.(this.docStore)

    this.recoveryManager = new RecoveryManager({
      accountId: deps.accountId,
      eventHub: deps.clientEventHub,
    })

    this.snapshotManager = new SnapshotManager(
      {
        accountId: deps.accountId,
        repo: deps.repo,
        broker: deps.broker,
        getLatestCursor: () => this.pullQueueManager.getGlobalLatestCursor(),
        eventHub: deps.clientEventHub,
        recoveryManager: this.recoveryManager,
        apiClient: this.apiClient,
      },
      this.lastModifiedStore
    )

    this.orchestrator = new SyncOrchestrator(
      deps.accountId,
      deps.broker,
      deps.clientEventHub,
      deps.internalEventHub,
      deps.pullQueueManager
    )

    this.orchestrator.onLeaderChange = isLeader => {
      this.snapshotManager.setLeader(isLeader)
    }
    this.snapshotManager.setLeader(this.orchestrator.leader)

    this.itemOperations = new ItemOperations({
      accountId: deps.accountId,
      docStore: this.docStore,
      indexManager: this.indexManager,
      eventHub: deps.clientEventHub,
      markDocumentDirty: id => this.snapshotManager.markItemDirty(id),
      recoveryManager: this.recoveryManager,
    })

    this.pullQueueManager.onDecryptionFailure = (itemId, error) => {
      void this.itemOperations.reportDecryptionFailure(itemId, error)
    }

    this.pullQueueManager.onPendingPullsAvailable = () => {
      this.broker.onFlushNeeded?.()
    }

    this.broker.onItemMessageParsed = itemId => {
      void this.itemOperations.clearManualRecoveryForItems([itemId])
      deps.onItemMessageParsed?.(itemId)
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

    this.manifestSyncManager = new ManifestSyncManager(
      {
        accountId: deps.accountId,
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

    // 2. Quota recovery listener
    this.lifecycle.register({
      name: 'QuotaRecovery',
      onStop: () => {
        if (this.unregisterQuotaRecovery) {
          this.unregisterQuotaRecovery()
          this.unregisterQuotaRecovery = null
        }
      },
    })

    // 3. IndexManager
    this.lifecycle.register({
      name: 'IndexManager',
      onStart: async () => {
        await this.indexManager.ensureIndexDocument()
      },
      onStop: () => {
        this.indexManager.close?.()
      },
    })

    // 4. ItemOperations
    this.lifecycle.register({
      name: 'ItemOperations',
      onStop: () => {
        this.itemOperations.resetRecoveryState()
      },
    })

    // 5. DocStore
    this.lifecycle.register({
      name: 'DocStore',
      onStop: async () => {
        await this.docStore.shutdown()
      },
    })

    // 6. SnapshotManager
    this.lifecycle.register({
      name: 'SnapshotManager',
      onStart: async () => {
        await this.snapshotManager.loadLastModified()
      },
      onStop: async options => {
        await this.snapshotManager.shutdown(options)
      },
    })

    // 7. SyncedHeads
    this.lifecycle.register({
      name: 'SyncedHeads',
      onStart: async () => {
        const storedHeads = await this.syncedHeadsStore.loadSyncedHeads()
        if (storedHeads && storedHeads.length > 0) {
          this.adapter.loadSyncedHeads(storedHeads)
        }
      },
    })

    // 8. PullQueueManager
    this.lifecycle.register({
      name: 'PullQueueManager',
      onStop: async options => {
        await this.pullQueueManager.shutdown(options)
      },
    })

    // 9. ManifestSyncManager
    this.lifecycle.register({
      name: 'ManifestSyncManager',
      onStop: () => {
        this.manifestSyncManager.shutdown()
      },
    })

    // 10. SyncOrchestrator (starts last, stops first)
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
