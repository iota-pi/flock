import type { DocumentId } from '@automerge/automerge-repo/slim'
import type { ItemId } from '@vault/shared'
import type { AutomergeDocStore } from './docStore'
import type { AutomergeRepoManager } from './AutomergeRepoManager'
import type { ItemOperations } from './ItemOperations'
import type { ItemReconciler } from './ItemReconciler'
import type { RecoveryManager } from './RecoveryManager'
import type { SnapshotPusher } from './SnapshotPusher'
import type { SnapshotSchedule } from './SnapshotSchedule'
import { toDocumentIdFromItemId } from './utils/automerge'
import { fireAndForget } from '../utils/fireAndForget'

export interface ItemRecoveryServiceDeps {
  repoManager: AutomergeRepoManager
  docStore: AutomergeDocStore
  recoveryManager: RecoveryManager
  snapshotSchedule: Pick<SnapshotSchedule, 'markItemDirty'>
  snapshotPusher: Pick<SnapshotPusher, 'flushPendingSnapshots' | 'clearOversized'>
  reconciler: Pick<ItemReconciler, 'reconcile'>
  /**
   * Runs a poll that fetches the item's snapshot, and returns whether the server's copy merged. False
   * when the poll failed or didn't run.
   */
  reconcileItem: (itemId: ItemId) => Promise<boolean>
  itemOperations: ItemOperations
  /** Called once an unreadable document's local copy has been removed, so it's no longer reported unreadable */
  onLocalCopyDiscarded: (documentId: DocumentId) => void
}

/** The actions the app offers for items in recovery */
export class ItemRecoveryService {
  constructor(private readonly deps: ItemRecoveryServiceDeps) {}

  /**
   * Replaces an item whose local copy can't be decrypted with the server's copy. Changes this device
   * hadn't pushed are lost, so the app asks first. The item stays quarantined if the server has no
   * copy to replace it with.
   */
  async replaceFromServer(itemId: ItemId): Promise<void> {
    const { repoManager, docStore, recoveryManager } = this.deps
    const documentId = toDocumentIdFromItemId(itemId)
    // Drops the handle that never finished loading. Its chunks are removed here rather than left to
    // the Repo, which doesn't wait for that.
    repoManager.repo.delete(documentId)
    await repoManager.storage.removeRange([documentId])
    this.deps.onLocalCopyDiscarded(documentId)

    // Fetched on its own, so other items failing to sync can't fail it. There's no longer a local copy
    // to keep, and the hydrator merges into whatever arrived meanwhile rather than replace it (rule 2).
    const settled = await this.deps.reconcileItem(itemId)
    if (!settled || !(await docStore.hasDataInStorage(itemId))) {
      throw new Error(`The server's copy of ${itemId} could not be downloaded. Try again once sync has finished.`)
    }
    await recoveryManager.unquarantine(itemId)
  }

  /**
   * Releases a quarantined item, pushes its snapshot again and fetches the server's. The fetch is a
   * merge, so it's harmless where the server's copy was never the problem; where it was (a snapshot
   * that didn't decrypt or hydrate), a fetch that fails again quarantines the item again.
   */
  async retryRecoveryItem(itemId: ItemId): Promise<void> {
    const { recoveryManager, snapshotSchedule, snapshotPusher, reconciler } = this.deps
    await recoveryManager.unquarantine(itemId)
    snapshotPusher.clearOversized(itemId)
    snapshotSchedule.markItemDirty(itemId)
    reconciler.reconcile(itemId, { fetch: true })
    fireAndForget(
      snapshotPusher.flushPendingSnapshots(),
      'ItemRecoveryService:retryRecoveryItem:flushPendingSnapshots',
    )
  }

  /** Copies an oversized item to a new ID and deletes the old one. Returns the new item's ID. */
  async recreateOversizedItem(itemId: ItemId): Promise<ItemId> {
    const { itemOperations, snapshotPusher } = this.deps
    const newItemId = await itemOperations.recreateOversizedItem(itemId)
    // The deleted old item is too large to upload, so it is pushed as a metadata-only tombstone
    snapshotPusher.clearOversized(itemId)
    fireAndForget(
      snapshotPusher.flushPendingSnapshots(),
      'ItemRecoveryService:recreateOversizedItem:flushPendingSnapshots',
    )
    return newItemId
  }
}
