import type { Repo } from '@automerge/automerge-repo/slim'

import { AutomergeDocStore } from './docStore'
import { AutomergeIndexManager } from './docStore/AutomergeIndexManager'
import { IndexStore } from './stores/IndexStore'
import { CursorStore } from './stores/CursorStore'
import { LastModifiedStore } from './stores/LastModifiedStore'
import { SnapshotManager } from './SnapshotManager'
import { SyncOrchestrator } from './SyncOrchestrator'
import { DeletionQueueManager } from './DeletionQueueManager'
import { ManifestSyncManager } from './ManifestSyncManager'
import { ItemOperations } from './ItemOperations'
import { SyncMessageBroker } from './SyncMessageBroker'
import { VaultNetworkAdapter } from './VaultEncryptedNetworkAdapter'
import { ClientEventHub, WorkerInternalEventHub } from './SyncEventHub'
import { SyncPullQueueManager } from './SyncPullQueueManager'
import { SyncWriteAheadLog } from './SyncWriteAheadLog'

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
  public readonly wal: SyncWriteAheadLog

  public readonly docStore: AutomergeDocStore
  public readonly indexManager: AutomergeIndexManager
  public readonly pullQueueManager: SyncPullQueueManager
  public readonly snapshotManager: SnapshotManager
  public readonly orchestrator: SyncOrchestrator
  public readonly deletionQueueManager: DeletionQueueManager
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
    this.wal = deps.wal ?? new SyncWriteAheadLog(deps.accountId)

    this.docStore = new AutomergeDocStore(deps.repo)

    this.snapshotManager = new SnapshotManager(
      {
        accountId: deps.accountId,
        repo: deps.repo,
        broker: deps.broker,
      },
      this.lastModifiedStore
    )

    this.orchestrator = new SyncOrchestrator(
      deps.accountId,
      deps.broker,
      deps.clientEventHub,
      deps.internalEventHub
    )

    this.deletionQueueManager = new DeletionQueueManager({
      accountId: deps.accountId,
      docStore: this.docStore,
      indexManager: this.indexManager,
    })

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

    this.broker.onItemMessageParsed = itemId => {
      void this.itemOperations.clearManualRecoveryForItems([itemId])
    }

    this.manifestSyncManager = new ManifestSyncManager(
      {
        accountId: deps.accountId,
        docStore: this.docStore,
        indexManager: this.indexManager,
        snapshotManager: this.snapshotManager,
      },
      items => this.itemOperations.storeItems(items),
      changes => this.itemOperations.mutateMetadata(changes),
    )
  }

  async initialize() {
    await Promise.all([
      this.indexManager.ensureIndexDocument(),
      this.snapshotManager.loadLastModified(),
    ])
    await this.orchestrator.start()
  }

  async shutdown(options?: { clearLocalData?: boolean }): Promise<void> {
    await this.orchestrator.shutdown()

    try {
      await this.pullQueueManager.shutdown()
    } catch (err) {
      console.error('[SyncWorkerContext] Error shutting down PullQueueManager', err)
    }

    try {
      await this.deletionQueueManager.shutdown()
    } catch (err) {
      console.error('[SyncWorkerContext] Error shutting down DeletionQueueManager', err)
    }

    try {
      await this.snapshotManager.shutdown()
    } catch (err) {
      console.error('[SyncWorkerContext] Error shutting down SnapshotManager', err)
    }

    try {
      await this.docStore.shutdown()
    } catch (err) {
      console.error('[SyncWorkerContext] Error shutting down DocStore repo', err)
    }

    this.itemOperations.resetRecoveryState()

    if (options?.clearLocalData) {
      try {
        await Promise.all([
          this.indexStore.clear(),
          this.cursorStore.clear(),
          this.lastModifiedStore.clear(),
          this.wal.clear(),
        ])
      } catch (err) {
        console.error('[SyncWorkerContext] Error clearing metadata stores on logout', err)
      }
    }
  }
}
