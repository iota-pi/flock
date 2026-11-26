import type { ItemId } from '@vault/shared'
import type { PendingMarkReader } from './ChangeOutbox'
import type { AutomergeDocStore, AutomergeIndexManager } from './docStore'
import type { ItemSyncState } from './ItemSyncState'
import { areHeadsEqual } from './utils/automerge'
import { AsyncMutex } from '../utils/AsyncMutex'

export interface IncomingChangesDeps {
  docStore: Pick<AutomergeDocStore, 'applyIncomingChanges' | 'flushToStorage' | 'getAutomergeItem'>
  indexManager: Pick<AutomergeIndexManager, 'addItemIds' | 'removeItemIds'>
  /** The outbox's pending marks (see `readPendingMarks`) */
  marks: PendingMarkReader
  itemSyncState: Pick<ItemSyncState, 'getServerHeads' | 'setServerHeads'>
  /** Called for each item log changes were applied to, so the app sees a new document */
  onItemApplied: (itemId: ItemId) => void
  /** Whether an item is kept out of the index here, such as the account settings doc, which isn't an item */
  isUnindexed?: (itemId: ItemId) => boolean
}

/** Applies decrypted log rows to docs, for the puller and for the gap healer's retries */
export class IncomingChanges {
  /** Items whose docs gained changes they didn't have, until the puller records them for snapshot coverage */
  private readonly addedChanges = new Set<ItemId>()
  /** Items changes were applied to, until `indexApplied` lists or tombstones them */
  private readonly unindexed = new Set<ItemId>()
  /**
   * Indexing runs one call at a time. Otherwise an earlier call that read an item live could list it
   * after a later one tombstoned it, and listing takes an item out of the tombstones (rule 2).
   */
  private readonly indexMutex = new AsyncMutex()

  constructor(private readonly deps: IncomingChangesDeps) {}

  /**
   * Reads which items are marked pending, so a page of rows can share one read. A mark written after
   * this is seen a page late, which the heads check in `apply` covers: the edit it marks moved the doc
   * off its server heads.
   */
  async readPending(): Promise<ReadonlySet<ItemId>> {
    return new Set(await this.deps.marks.listPending())
  }

  /**
   * Applies a row. Returns false when its dependencies are missing, and nothing was stored for an
   * unloaded doc. Applying never marks an item pending. `pending` is a `readPending` result to use
   * instead of reading the item's mark.
   *
   * Server heads follow the doc only if the doc matched them before these changes. Otherwise it held
   * changes of its own, which its mark may not have reached storage to say, so they'd never be pushed.
   */
  async apply(itemId: ItemId, bytes: Uint8Array, pending?: ReadonlySet<ItemId>): Promise<boolean> {
    const isPending = pending ? pending.has(itemId) : await this.deps.marks.isPending(itemId)
    const result = await this.deps.docStore.applyIncomingChanges(itemId, bytes, ({ headsBefore, headsAfter }) => {
      if (isPending || !headsBefore || !areHeadsEqual(headsBefore, this.deps.itemSyncState.getServerHeads(itemId))) return
      this.deps.itemSyncState.setServerHeads(itemId, headsAfter)
    })
    if (result.status === 'missingDeps') return false

    if (!this.deps.isUnindexed?.(itemId)) {
      this.unindexed.add(itemId)
    }
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

  /**
   * Lists the items changes were applied to in the index, or moves the deleted ones to its tombstones
   * (rule 2), once their docs are in storage, as the manifest hydrator does: an indexed item whose doc
   * a crash lost would never be fetched again (rule 1). Throws if storage fails, keeping the items for
   * the next call. The puller calls this after each page and the gap healer after each run, so the
   * index doesn't depend on the app subscribing to the items.
   */
  async indexApplied(): Promise<void> {
    await this.indexMutex.runExclusive(() => this.indexAppliedExclusive())
  }

  private async indexAppliedExclusive(): Promise<void> {
    // Taken now, so an item changed again meanwhile is indexed by the next call
    const itemIds = Array.from(this.unindexed)
    if (itemIds.length === 0) return
    this.unindexed.clear()
    try {
      await this.deps.docStore.flushToStorage(itemIds)
      const live: ItemId[] = []
      const deleted: ItemId[] = []
      for (const itemId of itemIds) {
        const item = await this.deps.docStore.getAutomergeItem(itemId)
        if (item?.deleted) {
          deleted.push(itemId)
        } else if (item) {
          live.push(itemId)
        }
      }
      if (live.length > 0) {
        await this.deps.indexManager.addItemIds(live)
      }
      if (deleted.length > 0) {
        await this.deps.indexManager.removeItemIds(deleted)
      }
    } catch (error) {
      for (const itemId of itemIds) {
        this.unindexed.add(itemId)
      }
      throw error
    }
  }
}
