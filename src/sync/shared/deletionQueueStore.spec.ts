import { ItemId } from 'src/shared/schemas/items'
import {
  scheduleDeletion,
  cancelDeletion,
  listScheduledDeletions,
  clearScheduledDeletions,
} from './deletionQueueStore'

describe('deletionQueueStore', () => {
  const accountId = 'test-account'

  beforeEach(async () => {
    await clearScheduledDeletions(accountId)
  })

  it('schedules and lists deletions', async () => {
    const itemId1 = 'item-1' as ItemId
    const itemId2 = 'item-2' as ItemId
    const gracePeriod = 60000 // 1 minute

    await scheduleDeletion(accountId, itemId1, gracePeriod)
    await scheduleDeletion(accountId, itemId2, gracePeriod)

    const list = await listScheduledDeletions(accountId)
    expect(list).toHaveLength(2)

    const ids = list.map(item => item.itemId)
    expect(ids).toContain(itemId1)
    expect(ids).toContain(itemId2)

    // Check timestamps are in the future
    const now = Date.now()
    for (const item of list) {
      expect(item.accountId).toBe(accountId)
      expect(item.scheduledTime).toBeGreaterThanOrEqual(now + gracePeriod - 1000)
    }
  })

  it('cancels scheduled deletions', async () => {
    const itemId = 'item-1' as ItemId
    await scheduleDeletion(accountId, itemId, 60000)

    let list = await listScheduledDeletions(accountId)
    expect(list).toHaveLength(1)

    await cancelDeletion(accountId, itemId)

    list = await listScheduledDeletions(accountId)
    expect(list).toHaveLength(0)
  })

  it('clears scheduled deletions for account', async () => {
    await scheduleDeletion(accountId, 'item-1' as ItemId, 60000)
    await scheduleDeletion('other-account', 'item-2' as ItemId, 60000)

    await clearScheduledDeletions(accountId)

    const list1 = await listScheduledDeletions(accountId)
    expect(list1).toHaveLength(0)

    const list2 = await listScheduledDeletions('other-account')
    expect(list2).toHaveLength(1)

    // cleanup other-account
    await clearScheduledDeletions('other-account')
  })
})
