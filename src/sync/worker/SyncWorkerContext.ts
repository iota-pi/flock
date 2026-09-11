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
import { SyncMessageBroker } from './SyncMessageBroker'
import { VaultNetworkAdapter } from './VaultEncryptedNetworkAdapter'
import { ClientEventHub, WorkerInternalEventHub } from './SyncEventHub'
import { SyncPullQueueManager } from './SyncPullQueueManager'
import { SyncWriteAheadLog } from './SyncWriteAheadLog'
import { toDocumentIdFromItemId, toVaultItemIdFromAutomergeId } from './utils/automerge'
import type { ItemId } from 'src/shared/schemas/items'

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
}

export class SyncWorkerContext {
  public readonly accountId: string
  public readonly repo: Repo
  public readonly adapter: VaultNetworkAdapter
  public readonly broker: SyncMessageBroker
  public readonly clientEventHub: ClientEventHub
  public readonly internalEventHub: WorkerInternalEventHub

  public readonly indexStore: IndexStore
  public readonly cursorStore: CursorStore
  public readonly lastModifiedStore: LastModifiedStore
  public readonly syncedHeadsStore: SyncedHeadsStore
  public readonly wal: SyncWriteAheadLog

  public readonly docStore: AutomergeDocStore
  public readonly indexManager: AutomergeIndexManager
  public readonly pullQueueManager: SyncPullQueueManager
  public readonly snapshotManager: SnapshotManager
  public readonly orchestrator: SyncOrchestrator
  public readonly manifestSyncManager: ManifestSyncManager
  public readonly itemOperations: ItemOperations

  constructor(deps: SyncWorkerContextDeps) {
    this.accountId = deps.accountId
    this.repo = deps.repo
    this.adapter = deps.adapter
    this.broker = deps.broker
    this.clientEventHub = deps.clientEventHub
    this.internalEventHub = deps.internalEventHub

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

    this.snapshotManager = new SnapshotManager(
      {
        accountId: deps.accountId,
        repo: deps.repo,
        broker: deps.broker,
        getLatestCursor: () => this.pullQueueManager.getGlobalLatestCursor(),
        eventHub: deps.clientEventHub,
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
          const documentId = toDocumentIdFromItemId(itemId)
          this.adapter.triggerReNegotiation?.(documentId)
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
  }

  async initialize() {
    await Promise.all([
      this.indexManager.ensureIndexDocument(),
      this.snapshotManager.loadLastModified(),
    ])

    const storedHeads = await this.syncedHeadsStore.loadSyncedHeads()
    if (storedHeads && storedHeads.length > 0) {
      this.adapter.loadSyncedHeads(storedHeads)
    }

    await this.orchestrator.start()
  }

  async shutdown(options?: { clearLocalData?: boolean }): Promise<void> {
    await this.orchestrator.shutdown()

    try {
      await this.pullQueueManager.shutdown(options)
    } catch (err) {
      console.error('[SyncWorkerContext] Error shutting down PullQueueManager', err)
    }

    try {
      await this.snapshotManager.shutdown(options)
    } catch (err) {
      console.error('[SyncWorkerContext] Error shutting down SnapshotManager', err)
    }

    try {
      await this.docStore.shutdown()
    } catch (err) {
      console.error('[SyncWorkerContext] Error shutting down DocStore repo', err)
    }

    this.itemOperations.resetRecoveryState()

    try {
      this.indexManager.close?.()
    } catch (err) {
      console.error('[SyncWorkerContext] Error closing indexManager', err)
    }

    if (options?.clearLocalData) {
      try {
        await Promise.all([
          this.indexStore.clear(),
          this.cursorStore.clear(),
          this.lastModifiedStore.clear(),
          this.wal.clear(),
          this.syncedHeadsStore.clear(),
        ])
      } catch (err) {
        console.error('[SyncWorkerContext] Error clearing metadata stores on logout', err)
      }
    }
  }
}
