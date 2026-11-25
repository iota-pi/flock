import type { ItemId } from '@vault/shared'
import type { AutomergeDocStore } from './docStore'
import type { ItemSyncState } from './ItemSyncState'
import { areHeadsEqual } from './utils/automerge'

export interface IncomingChangesDeps {
  docStore: Pick<AutomergeDocStore, 'applyIncomingChanges'>
  /** Whether the item has a pending mark (see `hasPendingMark`) */
  isPending: (itemId: ItemId) => Promise<boolean>
  itemSyncState: Pick<ItemSyncState, 'getServerHeads' | 'setServerHeads'>
  /** Called for each item log changes were applied to, so the app sees a new document */
  onItemApplied: (itemId: ItemId) => void
}

/** Applies decrypted log rows to docs, for the puller and for the gap healer's retries */
export class IncomingChanges {
  /** Items whose docs gained changes they didn't have, until the puller records them for snapshot coverage */
  private readonly addedChanges = new Set<ItemId>()

  constructor(private readonly deps: IncomingChangesDeps) {}

  /**
   * Applies a row. Returns false when its dependencies are missing, and nothing was stored for an
   * unloaded doc. Applying never marks an item pending.
   *
   * Server heads follow the doc only if the doc matched them before these changes. Otherwise it held
   * changes of its own, which its mark may not have reached storage to say, so they'd never be pushed.
   */
  async apply(itemId: ItemId, bytes: Uint8Array): Promise<boolean> {
    const isPending = await this.deps.isPending(itemId)
    const result = await this.deps.docStore.applyIncomingChanges(itemId, bytes, ({ headsBefore, headsAfter }) => {
      if (isPending || !headsBefore || !areHeadsEqual(headsBefore, this.deps.itemSyncState.getServerHeads(itemId))) return
      this.deps.itemSyncState.setServerHeads(itemId, headsAfter)
    })
    if (result.status === 'missingDeps') return false

    this.deps.onItemApplied(itemId)
    if (result.addedChanges) {
      this.addedChanges.add(itemId)
    }
    return true
  }

  /**
   * Returns the items whose docs gained changes since the last call, from the puller's rows and the
   * gap healer's retries alike, and forgets them
   */
  takeAddedChanges(): ItemId[] {
    const itemIds = Array.from(this.addedChanges)
    this.addedChanges.clear()
    return itemIds
  }
}
