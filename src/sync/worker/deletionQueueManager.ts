import { AutomergeDocStore } from './docStore'
import { AutomergeIndexManager } from './docStore/AutomergeIndexManager'
import {
  scheduleDeletion,
  cancelDeletion,
  listScheduledDeletions,
  clearScheduledDeletions,
} from '../shared/deletionQueueStore'
import type { ItemId } from 'src/shared/schemas/items'

export class DeletionQueueManager {
  private deletionGracePeriodMs = 24 * 60 * 60 * 1000 // 24 hours
  private deletionQueueCheckInterval = 60 * 1000 // 1 minute
  private deletionQueueTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private deps: {
      accountId: string
      docStore: AutomergeDocStore
      indexManager: AutomergeIndexManager
    }
  ) {}

  startTimer() {
    this.stopTimer()
    this.deletionQueueTimer = setInterval(
      () => void this.processQueue(),
      this.deletionQueueCheckInterval
    )
  }

  stopTimer() {
    if (this.deletionQueueTimer) {
      clearInterval(this.deletionQueueTimer)
      this.deletionQueueTimer = null
    }
  }

  async shutdown(): Promise<void> {
    this.stopTimer()
    await this.clearQueue().catch(console.error)
  }

  async handleIndexChange(newItemIdsSet: Set<ItemId>, subscribedIds: Set<ItemId>) {
    // 1. Cancel scheduled deletions for items that have reappeared in the index
    try {
      const scheduled = await listScheduledDeletions(this.deps.accountId)
      for (const item of scheduled) {
        if (newItemIdsSet.has(item.itemId)) {
          await cancelDeletion(this.deps.accountId, item.itemId)
        }
      }
    } catch (err) {
      console.error('[DeletionQueueManager] Failed to cancel scheduled deletions', err)
    }

    // 2. Schedule deletions for items that were removed from the index
    const deletedIds = Array.from(subscribedIds).filter(id => !newItemIdsSet.has(id))
    for (const deletedId of deletedIds) {
      scheduleDeletion(this.deps.accountId, deletedId, this.deletionGracePeriodMs).catch(console.error)
    }
  }

  async processQueue() {
    try {
      const scheduled = await listScheduledDeletions(this.deps.accountId)
      const now = Date.now()
      const expired = scheduled.filter(item => item.scheduledTime <= now)

      if (expired.length > 0) {
        const itemIds = await this.deps.indexManager.listAutomergeItemIds()

        for (const item of expired) {
          if (itemIds.includes(item.itemId)) {
            // Re-appeared, cancel deletion
            await cancelDeletion(this.deps.accountId, item.itemId)
            continue
          }

          await this.deps.docStore.removeAutomergeItem(item.itemId)
          await this.deps.indexManager.removeAutomergeItemIdsFromIndex([item.itemId])
          await cancelDeletion(this.deps.accountId, item.itemId)
        }
      }
    } catch (err) {
      console.error('[DeletionQueueManager] Error processing deletion queue', err)
    }
  }

  async cancelDeletion(itemId: ItemId) {
    await cancelDeletion(this.deps.accountId, itemId)
  }

  async clearQueue() {
    await clearScheduledDeletions(this.deps.accountId)
  }
}
