import type { ItemId } from '@vault/shared'
import { BoundedMap } from '../utils/BoundedMap'

const BATCH_PROGRESS_CACHE_MAX = 500

/**
 * For each item, how many messages of each partly applied batch (by cursor) have been applied,
 * so a retried pull resumes the batch after the messages the adapter already received.
 */
export class BatchProgress {
  private readonly progress = new BoundedMap<ItemId, Map<number, number>>(BATCH_PROGRESS_CACHE_MAX)

  get(itemId: ItemId, cursor: number): number {
    return this.progress.get(itemId)?.get(cursor) ?? 0
  }

  set(itemId: ItemId, cursor: number, count: number): void {
    const itemProgress = this.progress.get(itemId)
    if (itemProgress) {
      itemProgress.set(cursor, count)
    } else {
      this.progress.set(itemId, new Map([[cursor, count]]))
    }
  }

  /** Forgets the batch at `cursor` */
  clear(itemId: ItemId, cursor: number): void {
    const itemProgress = this.progress.get(itemId)
    itemProgress?.delete(cursor)
    if (itemProgress?.size === 0) {
      this.progress.delete(itemId)
    }
  }

  /** Forgets every batch at or below `cursor` */
  clearUpTo(itemId: ItemId, cursor: number): void {
    const itemProgress = this.progress.get(itemId)
    if (!itemProgress) return
    for (const entryCursor of itemProgress.keys()) {
      if (entryCursor <= cursor) {
        itemProgress.delete(entryCursor)
      }
    }
    if (itemProgress.size === 0) {
      this.progress.delete(itemId)
    }
  }

  clearItem(itemId: ItemId): void {
    this.progress.delete(itemId)
  }

  clearAll(): void {
    this.progress.clear()
  }
}
