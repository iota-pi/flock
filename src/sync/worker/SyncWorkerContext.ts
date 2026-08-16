import type { Repo } from '@automerge/automerge-repo/slim'

import { AutomergeDocStore } from './docStore'
import { AutomergeIndexManager } from './docStore/AutomergeIndexManager'
import { BackupManager } from './docStore/BackupManager'
import { IndexStore } from './stores/IndexStore'
import { CursorStore } from './stores/CursorStore'
import { LastModifiedStore } from './stores/LastModifiedStore'
import { SnapshotManager } from './SnapshotManager'
import { SyncOrchestrator } from './SyncOrchestrator'
import { DeletionQueueManager } from './DeletionQueueManager'
import { RecoveryManager } from './RecoveryManager'
import { VaultBootstrapper } from './VaultBootstrapper'
import { ReencryptionManager } from './ReencryptionManager'
import { ItemOperations } from './ItemOperations'
import { SyncMessageBroker } from './SyncMessageBroker'
import { VaultNetworkAdapter } from './VaultEncryptedNetworkAdapter'
import { ClientEventHub, WorkerInternalEventHub } from './SyncEventHub'
import { SyncPullQueueManager } from './SyncPullQueueManager'
import type { Item } from 'src/state/items'
import type { AccountMetadata } from 'src/state/metadata'


export class SyncWorkerContext {
  public readonly indexStore: IndexStore
  public readonly cursorStore: CursorStore
  public readonly lastModifiedStore: LastModifiedStore

  public readonly docStore: AutomergeDocStore
  public readonly indexManager: AutomergeIndexManager
  public readonly backupManager: BackupManager
  public readonly pullQueueManager: SyncPullQueueManager
  public readonly snapshotManager: SnapshotManager
  public readonly orchestrator: SyncOrchestrator
  public readonly deletionQueueManager: DeletionQueueManager
  public readonly recoveryManager: RecoveryManager
  public readonly vaultBootstrapper: VaultBootstrapper
  public readonly reencryptionManager: ReencryptionManager
  public readonly itemOperations: ItemOperations

  constructor(
    public readonly accountId: string,
    public readonly repo: Repo,
    public readonly adapter: VaultNetworkAdapter,
    public readonly broker: SyncMessageBroker,
    public readonly clientEventHub: ClientEventHub,
    public readonly internalEventHub: WorkerInternalEventHub,
    indexStore: IndexStore,
    indexManager: AutomergeIndexManager,
    cursorStore: CursorStore,
    pullQueueManager: SyncPullQueueManager,
    legacyStoreItems: (items: Item[]) => Promise<void>,
    legacyMutateMetadata: (changes: Partial<AccountMetadata>) => Promise<void>
  ) {
    this.indexStore = indexStore
    this.indexManager = indexManager
    this.cursorStore = cursorStore
    this.pullQueueManager = pullQueueManager
    this.lastModifiedStore = new LastModifiedStore(accountId)

    this.docStore = new AutomergeDocStore(repo)
    this.backupManager = new BackupManager(this.docStore, indexManager)

    this.snapshotManager = new SnapshotManager({
      accountId,
      repo,
      broker,
    }, this.lastModifiedStore)

    this.orchestrator = new SyncOrchestrator(accountId, broker, clientEventHub, internalEventHub)

    this.deletionQueueManager = new DeletionQueueManager({
      accountId,
      docStore: this.docStore,
      indexManager: this.indexManager,
    })

    this.recoveryManager = new RecoveryManager({
      accountId,
      docStore: this.docStore,
      indexManager: this.indexManager,
    }, clientEventHub)

    this.vaultBootstrapper = new VaultBootstrapper(
      {
        accountId,
        docStore: this.docStore,
        indexManager: this.indexManager,
      },
      legacyStoreItems,
      legacyMutateMetadata
    )

    this.reencryptionManager = new ReencryptionManager({
      accountId,
      repo,
      indexManager: this.indexManager,
    })

    this.itemOperations = new ItemOperations({
      accountId,
      docStore: this.docStore,
      indexManager: this.indexManager,
      eventHub: clientEventHub,
      markDocumentDirty: id => this.snapshotManager.markItemDirty(id),
      deletionQueueManager: this.deletionQueueManager,
    })
  }

  async initialize() {
    await Promise.all([
      this.indexManager.ensureIndexDocument(),
      this.snapshotManager.loadLastModified(),
      this.orchestrator.start(),
    ])
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

    if (options?.clearLocalData) {
      try {
        await Promise.all([
          this.indexStore.clear(),
          this.cursorStore.clear(),
          this.lastModifiedStore.clear(),
        ])
      } catch (err) {
        console.error('[SyncWorkerContext] Error clearing metadata stores on logout', err)
      }
    }
  }
}
