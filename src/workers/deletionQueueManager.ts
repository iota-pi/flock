import { removeAutomergeItem } from '../sync/docStore'

import {
  scheduleDeletion,
  cancelDeletion,
  listScheduledDeletions,
  clearScheduledDeletions,
} from '../sync/deletionQueueStore'
import type { ItemId } from 'src/shared/schemas/items'


export class DeletionQueueManager {
  private deletionGracePeriodMs = 24 * 60 * 60 * 1000 // 24 hours
  private deletionQueueCheckInterval = 60 * 1000 // 1 minute
  private deletionQueueTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private getContext: () => {
      accountId: string | null
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
    const { accountId } = this.getContext()
    if (!accountId) return

    // 1. Cancel scheduled deletions for items that have reappeared in the index
    try {
      const scheduled = await listScheduledDeletions(accountId)
      for (const item of scheduled) {
        if (newItemIdsSet.has(item.itemId)) {
          await cancelDeletion(accountId, item.itemId)
        }
      }
    } catch (err) {
      console.error('[DeletionQueueManager] Failed to cancel scheduled deletions', err)
    }

    // 2. Schedule deletions for items that were removed from the index
    const deletedIds = Array.from(subscribedIds).filter(id => !newItemIdsSet.has(id))
    for (const deletedId of deletedIds) {
      scheduleDeletion(accountId, deletedId, this.deletionGracePeriodMs).catch(console.error)
    }
  }

  async processQueue() {
    const { accountId } = this.getContext()
    if (!accountId) return

    try {
      const scheduled = await listScheduledDeletions(accountId)
      const now = Date.now()
      const expired = scheduled.filter(item => item.scheduledTime <= now)

      if (expired.length > 0) {
        const { listAutomergeItemIds } = await import('../sync/docStore/indexManager')
        const itemIds = await listAutomergeItemIds(accountId)

        for (const item of expired) {
          if (itemIds.includes(item.itemId)) {
            // Re-appeared, cancel deletion
            await cancelDeletion(accountId, item.itemId)
            continue
          }

          await removeAutomergeItem(accountId, item.itemId)
          await cancelDeletion(accountId, item.itemId)
        }
      }
    } catch (err) {
      console.error('[DeletionQueueManager] Error processing deletion queue', err)
    }
  }

  async cancelDeletion(itemId: ItemId) {
    const { accountId } = this.getContext()
    if (!accountId) return
    await cancelDeletion(accountId, itemId)
  }

  async clearQueue() {
    const { accountId } = this.getContext()
    if (!accountId) return
    await clearScheduledDeletions(accountId)
  }
}
