import type { DocumentId } from '@automerge/automerge-repo/slim'
import type { ItemId } from '@vault/shared'
import type { AutomergeDocStore } from './docStore'
import type { AutomergeRepoManager } from './AutomergeRepoManager'
import type { ItemOperations } from './ItemOperations'
import type { ManifestMode, ManifestPhaseResult } from './ManifestSyncManager'
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
  /** Runs a poll whose manifest phase syncs at `mode`, returning that sync's result */
  syncManifest: (mode: ManifestMode) => Promise<ManifestPhaseResult>
  itemOperations: ItemOperations
  /** Makes this tab the leader, which alone talks to the server, or throws */
  becomeLeader: () => Promise<void>
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
    // Before the local copy goes, so a tab that can't fetch the server's copy keeps it
    await this.deps.becomeLeader()
    const documentId = toDocumentIdFromItemId(itemId)
    // Drops the handle that never finished loading. Its chunks are removed here rather than left to
    // the Repo, which doesn't wait for that.
    repoManager.repo.delete(documentId)
    await repoManager.storage.removeRange([documentId])
    this.deps.onLocalCopyDiscarded(documentId)

    // A forced sync fetches quarantined items, and there's no longer a local copy to keep
    const result = await this.deps.syncManifest('force')
    if (!result.success || !(await docStore.hasDataInStorage(itemId))) {
      throw new Error(`The server's copy of ${itemId} could not be downloaded. Try again once sync has finished.`)
    }
    await recoveryManager.unquarantine(itemId)
  }

  /** Releases a quarantined item and pushes its snapshot again */
  async retryRecoveryItem(itemId: ItemId): Promise<void> {
    const { recoveryManager, snapshotSchedule, snapshotPusher } = this.deps
    await recoveryManager.unquarantine(itemId)
    snapshotPusher.clearOversized(itemId)
    snapshotSchedule.markItemDirty(itemId)
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
