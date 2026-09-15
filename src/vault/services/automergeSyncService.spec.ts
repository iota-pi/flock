import type { Mocked } from 'vitest'
import { createAutomergeSyncService } from './automergeSyncService'
import type { AutomergeSyncRepository } from './automergeSyncRepository'
import { ItemId } from 'src/shared/schemas/items'

describe('AutomergeSyncService', () => {
  const CUSTOM_EPOCH = 1760000000000 // 2026-01-01T00:00:00.000Z
  const TIMESTAMP_MULTIPLIER = 10_000_000

  const createMockRepository = () => {
    return {
      appendSyncMessage: vi.fn(),
      pushSyncMessagesBatch: vi.fn(),
      getSyncMessages: vi.fn(),
    } as unknown as Mocked<AutomergeSyncRepository>
  }

  it('generates monotonically increasing cursors within a batch and preserves absolute timestamps', async () => {
    const repository = createMockRepository()
    const mockedTime = 1772473432000 // A date in June 2026
    const service = createAutomergeSyncService({
      now: () => mockedTime,
      repository,
    })

    const messages = [
      { itemId: 'item-1' as ItemId, encryptedMessage: { iv: 'iv1', cipher: 'c1' } },
      { itemId: 'item-1' as ItemId, encryptedMessage: { iv: 'iv2', cipher: 'c2' } },
      { itemId: 'item-1' as ItemId, encryptedMessage: { iv: 'iv3', cipher: 'c3' } },
    ]

    const result = await service.pushAutomergeSyncBatch({
      account: 'test-account',
      messages,
    })

    expect(result.success).toBe(true)
    expect(result.results.length).toBe(3)

    const cursor0 = result.results[0].cursor
    const cursor1 = result.results[1].cursor
    const cursor2 = result.results[2].cursor

    // Cursors should increment by exactly 1
    expect(cursor1).toBe(cursor0 + 1)
    expect(cursor2).toBe(cursor0 + 2)

    // Ensure all generated cursors are safe integers
    expect(Number.isSafeInteger(cursor0)).toBe(true)
    expect(Number.isSafeInteger(cursor1)).toBe(true)
    expect(Number.isSafeInteger(cursor2)).toBe(true)

    // Check that repository is called with the absolute timestamp for createdAt/lastModified
    expect(repository.pushSyncMessagesBatch).toHaveBeenCalledTimes(1)
    const callArgs = repository.pushSyncMessagesBatch.mock.calls[0][0]
    expect(callArgs.account).toBe('test-account')
    expect(callArgs.messages.length).toBe(3)

    expect(callArgs.messages[0].entry.createdAt).toBe(mockedTime)
    expect(callArgs.messages[0].lastModified).toBe(mockedTime)
    expect(callArgs.messages[0].entry.cursor).toBe(cursor0)
  })

  it('remains safe from precision loss (base + 1 === base is false)', async () => {
    const repository = createMockRepository()
    const service = createAutomergeSyncService({
      now: () => Date.now(),
      repository,
    })

    const result = await service.pushAutomergeSyncBatch({
      account: 'test-account',
      messages: [
        { itemId: 'item-1' as ItemId, encryptedMessage: { iv: 'iv1', cipher: 'c1' } },
        { itemId: 'item-1' as ItemId, encryptedMessage: { iv: 'iv2', cipher: 'c2' } },
      ],
    })

    const cursor0 = result.results[0].cursor
    const cursor1 = result.results[1].cursor
    expect(cursor1 === cursor0).toBe(false)
    expect(cursor1).toBe(cursor0 + 1)
  })

  it('safely handles system clocks set before the custom epoch', async () => {
    const repository = createMockRepository()
    // 0 is way before custom epoch
    const service = createAutomergeSyncService({
      now: () => 0,
      repository,
    })

    const result = await service.pushAutomergeSyncBatch({
      account: 'test-account',
      messages: [{ itemId: 'item-1' as ItemId, encryptedMessage: { iv: 'iv1', cipher: 'c1' } }],
    })

    const cursor = result.results[0].cursor
    expect(cursor).toBeGreaterThanOrEqual(0)
    // When time is 0, relative timestamp is 0, so the cursor is just the invocationOffset
    expect(cursor).toBeLessThan(TIMESTAMP_MULTIPLIER)
    expect(Number.isSafeInteger(cursor)).toBe(true)
  })

  it('ensures two pushes in the same millisecond have a very low collision rate due to scaled up offsets', async () => {
    const repository = createMockRepository()
    const mockedTime = 1772473432000
    const service = createAutomergeSyncService({
      now: () => mockedTime,
      repository,
    })

    const cursorSet = new Set<number>()
    const iterations = 500

    for (let i = 0; i < iterations; i++) {
      const result = await service.pushAutomergeSyncBatch({
        account: 'test-account',
        messages: [{
          itemId: 'item-1' as ItemId,
          encryptedMessage: { iv: `iv-${i}`, cipher: `c-${i}` },
        }],
      })
      cursorSet.add(result.results[0].cursor)
    }

    // Since iterations (500) is much smaller than MAX_OFFSET (9,999,000),
    // the probability of any collision in 500 pushes is extremely small (~0.01%).
    // We expect 500 unique cursors.
    expect(cursorSet.size).toBe(iterations)
  })

  it('ensures batch index does not spill over into the next second namespace', async () => {
    const repository = createMockRepository()
    const mockedTime = 1772473432000
    const service = createAutomergeSyncService({
      now: () => mockedTime,
      repository,
    })

    // Large batch of 200 items (maximum page limit)
    const messages = Array.from({ length: 200 }, (_, i) => ({
      itemId: 'item-1' as ItemId,
      encryptedMessage: { iv: `iv-${i}`, cipher: `c-${i}` },
    }))

    const result = await service.pushAutomergeSyncBatch({
      account: 'test-account',
      messages,
    })

    const firstCursor = result.results[0].cursor
    const lastCursor = result.results[result.results.length - 1].cursor

    const relativeTimestampMs = mockedTime - CUSTOM_EPOCH
    const relativeTimestampSeconds = Math.floor(relativeTimestampMs / 1000)
    const currentSecondNamespaceStart = relativeTimestampSeconds * TIMESTAMP_MULTIPLIER
    const nextSecondNamespaceStart = (relativeTimestampSeconds + 1) * TIMESTAMP_MULTIPLIER

    expect(firstCursor).toBeGreaterThanOrEqual(currentSecondNamespaceStart)
    expect(lastCursor).toBeLessThan(nextSecondNamespaceStart)
  })

  it('passes the raw input cursor when pulling sync messages for an item', async () => {
    const repository = createMockRepository()
    repository.getSyncMessages.mockResolvedValueOnce({ messages: [], hasMore: false })
    const service = createAutomergeSyncService({ repository })

    const inputCursor = 150_000_000 // 15 seconds into epoch
    await service.pullAutomergeSyncBatch({
      account: 'test-account',
      cursors: [{ itemId: 'item-1' as ItemId, cursor: inputCursor }],
    })

    expect(repository.getSyncMessages).toHaveBeenCalledWith({
      account: 'test-account',
      itemId: 'item-1',
      fromCursor: 150_000_000,
      limit: 200,
    })
  })

  it('passes the raw input cursor when querying global sync messages across items', async () => {
    const repository = {
      ...createMockRepository(),
      getGlobalSyncMessagesAfterCursor: vi.fn().mockResolvedValueOnce({ items: [], hasMore: false }),
    } as unknown as Mocked<AutomergeSyncRepository>
    const service = createAutomergeSyncService({ repository })

    const inputCursor = 200_000_000 // 20 seconds into epoch
    await service.pullAutomergeSyncGlobal({
      account: 'test-account',
      cursor: inputCursor,
    })

    expect(repository.getGlobalSyncMessagesAfterCursor).toHaveBeenCalledWith({
      account: 'test-account',
      cursor: 200_000_000,
    })
  })

  it('returns response-level hasMore and sets item-level hasMore to false for all items in pullAutomergeSyncGlobal', async () => {
    const repository = {
      ...createMockRepository(),
      getGlobalSyncMessagesAfterCursor: vi.fn().mockResolvedValueOnce({
        items: [
          {
            itemId: 'item-1' as ItemId,
            messages: [{ cursor: 10, encryptedMessage: { iv: 'iv1', cipher: 'c1' }, createdAt: 100 }],
          },
          {
            itemId: 'item-2' as ItemId,
            messages: [{ cursor: 20, encryptedMessage: { iv: 'iv2', cipher: 'c2' }, createdAt: 200 }],
          },
        ],
        hasMore: true,
      }),
    } as unknown as Mocked<AutomergeSyncRepository>
    const service = createAutomergeSyncService({ repository })

    const result = await service.pullAutomergeSyncGlobal({
      account: 'test-account',
      cursor: 5,
    })

    expect(result.success).toBe(true)
    expect(result.hasMore).toBe(true)
    expect(result.results).toHaveLength(2)
    // Both items must have hasMore: false so they are not hijacked into pullCursors
    expect(result.results[0].hasMore).toBe(false)
    expect(result.results[1].hasMore).toBe(false)
  })

  it('bypasses the 10-second overlap buffer and passes exclusiveStartKey during pagination continuation for an item', async () => {
    const repository = createMockRepository()
    const lastKey = { syncId: 'test-account#item-1', cursor: 150_000_199 }
    repository.getSyncMessages.mockResolvedValueOnce({
      messages: [],
      hasMore: false,
      lastEvaluatedKey: undefined,
    })
    const service = createAutomergeSyncService({ repository })

    const inputCursor = 150_000_199
    await service.pullAutomergeSyncBatch({
      account: 'test-account',
      cursors: [{ itemId: 'item-1' as ItemId, cursor: inputCursor, lastEvaluatedKey: lastKey }],
    })

    expect(repository.getSyncMessages).toHaveBeenCalledWith({
      account: 'test-account',
      itemId: 'item-1',
      fromCursor: undefined, // Must NOT subtract OVERLAP_CURSOR_DELTA or pass fromCursor
      exclusiveStartKey: lastKey,
      limit: 200,
    })
  })

  it('bypasses the 10-second overlap buffer and passes exclusiveStartKey during global sync pagination continuation', async () => {
    const repository = {
      ...createMockRepository(),
      getGlobalSyncMessagesAfterCursor: vi.fn().mockResolvedValueOnce({
        items: [],
        hasMore: false,
        lastEvaluatedKey: undefined,
      }),
    } as unknown as Mocked<AutomergeSyncRepository>
    const service = createAutomergeSyncService({ repository })

    const globalKey = { account: 'test-account', cursor: 200_000_999, syncId: 'test-account#item-5' }
    await service.pullAutomergeSyncGlobal({
      account: 'test-account',
      cursor: 200_000_999,
      lastEvaluatedKey: globalKey,
    })

    expect(repository.getGlobalSyncMessagesAfterCursor).toHaveBeenCalledWith({
      account: 'test-account',
      cursor: undefined, // Must NOT subtract OVERLAP_CURSOR_DELTA or pass cursor
      exclusiveStartKey: globalKey,
    })
  })

  it('terminates pagination cleanly on burst writes across pages without looping', async () => {
    const repository = createMockRepository()
    const page1Key = { syncId: 'test-account#item-1', cursor: 100_000_200 }
    const page1Messages = Array.from({ length: 200 }, (_, i) => ({
      cursor: 100_000_001 + i,
      encryptedMessage: { iv: `iv-${i}`, cipher: `c-${i}` },
      createdAt: 1000,
    }))
    const page2Messages = Array.from({ length: 50 }, (_, i) => ({
      cursor: 100_000_201 + i,
      encryptedMessage: { iv: `iv-${i + 200}`, cipher: `c-${i + 200}` },
      createdAt: 1000,
    }))

    // Page 1: fresh poll
    repository.getSyncMessages.mockResolvedValueOnce({
      messages: page1Messages,
      hasMore: true,
      lastEvaluatedKey: page1Key,
    })

    const service = createAutomergeSyncService({ repository })

    const page1Result = await service.pullAutomergeSyncBatch({
      account: 'test-account',
      cursors: [{ itemId: 'item-1' as ItemId, cursor: 100_000_000 }],
    })

    expect(page1Result.results[0].hasMore).toBe(true)
    expect(page1Result.results[0].lastEvaluatedKey).toEqual(page1Key)
    expect(page1Result.results[0].messages).toHaveLength(200)
    expect(repository.getSyncMessages).toHaveBeenLastCalledWith({
      account: 'test-account',
      itemId: 'item-1',
      fromCursor: 100_000_000,
      limit: 200,
      exclusiveStartKey: undefined,
    })

    // Page 2: continuation with lastEvaluatedKey
    repository.getSyncMessages.mockResolvedValueOnce({
      messages: page2Messages,
      hasMore: false,
      lastEvaluatedKey: undefined,
    })

    const page2Result = await service.pullAutomergeSyncBatch({
      account: 'test-account',
      cursors: [{
        itemId: 'item-1' as ItemId,
        cursor: page1Result.results[0].nextCursor,
        lastEvaluatedKey: page1Result.results[0].lastEvaluatedKey,
      }],
    })

    expect(page2Result.results[0].hasMore).toBe(false)
    expect(page2Result.results[0].lastEvaluatedKey).toBeUndefined()
    expect(page2Result.results[0].messages).toHaveLength(50)
    expect(repository.getSyncMessages).toHaveBeenLastCalledWith({
      account: 'test-account',
      itemId: 'item-1',
      fromCursor: undefined,
      limit: 200,
      exclusiveStartKey: page1Key,
    })
  })

  it('returns fromCursor as nextCursor when no new messages exist (client is caught up)', async () => {
    const repository = createMockRepository()
    repository.getSyncMessages.mockResolvedValueOnce({
      messages: [],
      hasMore: false,
      lastEvaluatedKey: undefined,
    })
    const service = createAutomergeSyncService({ repository })

    const result = await service.pullAutomergeSyncBatch({
      account: 'test-account',
      cursors: [{ itemId: 'item-1' as ItemId, cursor: 500_000 }],
    })

    expect(result.results[0].nextCursor).toBe(500_000)
    expect(result.results[0].messages).toHaveLength(0)
    expect(repository.getSyncMessages).toHaveBeenCalledWith({
      account: 'test-account',
      itemId: 'item-1',
      fromCursor: 500_000,
      limit: 200,
      exclusiveStartKey: undefined,
    })
  })
})
