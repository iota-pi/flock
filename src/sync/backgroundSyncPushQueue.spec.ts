import {
  appendBackgroundSyncPushCommits,
  consumeBackgroundSyncPushCommits,
  enqueueBackgroundSyncPushBatch,
  initializeBackgroundSyncPushQueue,
  listBackgroundSyncPushBatches,
  removeBackgroundSyncPushBatches,
} from './backgroundSyncPushQueue'

const describeIfIndexedDb = typeof indexedDB === 'undefined' ? describe.skip : describe

describeIfIndexedDb('backgroundSyncPushQueue', () => {
  beforeEach(async () => {
    await initializeBackgroundSyncPushQueue()
  })

  it('stores batches individually and deduplicates identical payloads', async () => {
    const account = `acct-${crypto.randomUUID()}`
    const messageItemId = `item-${crypto.randomUUID()}`

    const firstBatchId = await enqueueBackgroundSyncPushBatch({
      account,
      authToken: 'token-1',
      messages: [
        {
          itemId: messageItemId,
          encryptedMessage: {
            iv: 'iv-1',
            cipher: 'cipher-1',
          },
          nextSyncState: 'sync-state-1',
        },
      ],
    })

    const duplicateBatchId = await enqueueBackgroundSyncPushBatch({
      account,
      authToken: 'token-1',
      messages: [
        {
          itemId: messageItemId,
          encryptedMessage: {
            iv: 'iv-1',
            cipher: 'cipher-1',
          },
          nextSyncState: 'sync-state-1',
        },
      ],
    })

    expect(firstBatchId).toBeTruthy()
    expect(duplicateBatchId).toBe(firstBatchId)

    const listed = await listBackgroundSyncPushBatches()
    const matching = listed.filter(batch => batch.account === account)

    expect(matching).toHaveLength(1)

    if (firstBatchId) {
      await removeBackgroundSyncPushBatches([firstBatchId])
    }

    const remaining = await listBackgroundSyncPushBatches()
    expect(remaining.some(batch => batch.id === firstBatchId)).toBe(false)
  })

  it('upserts commits by account and item, then consumes per account', async () => {
    const account = `acct-${crypto.randomUUID()}`
    const itemId = `item-${crypto.randomUUID()}`

    // Drain any previous entries for this generated account.
    await consumeBackgroundSyncPushCommits(account)

    await appendBackgroundSyncPushCommits([
      {
        account,
        itemId,
        nextSyncState: 'state-1',
        committedAt: 1,
      },
      {
        account,
        itemId,
        nextSyncState: 'state-2',
        committedAt: 2,
      },
    ])

    const consumed = await consumeBackgroundSyncPushCommits(account)

    expect(consumed).toHaveLength(1)
    expect(consumed[0]?.itemId).toBe(itemId)
    expect(consumed[0]?.nextSyncState).toBe('state-2')

    const consumedAgain = await consumeBackgroundSyncPushCommits(account)
    expect(consumedAgain).toEqual([])
  })
})
