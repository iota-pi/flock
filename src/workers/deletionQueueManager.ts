import { AutomergeIndexDocument, removeAutomergeItem } from '../sync/automergeDocStore'
import type { DocHandle } from '@automerge/automerge-repo/slim'

import {
  scheduleDeletion,
  cancelDeletion,
  listScheduledDeletions,
  clearScheduledDeletions,
} from '../sync/deletionQueueStore'


export class DeletionQueueManager {
  private deletionGracePeriodMs = 24 * 60 * 60 * 1000 // 24 hours
  private deletionQueueCheckInterval = 60 * 1000 // 1 minute
  private deletionQueueTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private getContext: () => {
      accountId: string | null
      getIndexHandle: () => Promise<DocHandle<AutomergeIndexDocument> | undefined>
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

  async handleIndexChange(newItemIdsSet: Set<string>, subscribedIds: Set<string>) {
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
    const { accountId, getIndexHandle } = this.getContext()
    if (!accountId) return

    try {
      const scheduled = await listScheduledDeletions(accountId)
      const now = Date.now()
      const expired = scheduled.filter(item => item.scheduledTime <= now)

      for (const item of expired) {
        // Double check: is it in the current index document?
        const indexHandle = await getIndexHandle()
        if (indexHandle) {
          const indexDoc = indexHandle.doc()
          if (indexDoc && indexDoc.itemIds && indexDoc.itemIds.includes(item.itemId)) {
            // Re-appeared, cancel deletion
            await cancelDeletion(accountId, item.itemId)
            continue
          }
        }

        await removeAutomergeItem(accountId, item.itemId)
        await cancelDeletion(accountId, item.itemId)
      }
    } catch (err) {
      console.error('[DeletionQueueManager] Error processing deletion queue', err)
    }
  }

  async cancelDeletion(itemId: string) {
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
