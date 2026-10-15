import type { Mocked } from 'vitest'
import {
  createAutomergeSyncService,
  DEFAULT_PULL_BATCH_CONCURRENCY,
} from './automergeSyncService'
import { mapWithConcurrency, ItemId } from '@vault/shared'
import type { AutomergeSyncRepository } from './automergeSyncRepository'

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

  it('gives pushes in the same millisecond different cursors within that second', async () => {
    const repository = createMockRepository()
    const mockedTime = 1772473432000
    const service = createAutomergeSyncService({
      now: () => mockedTime,
      repository,
    })

    // Offsets are random, so stub them to keep the test deterministic (collisions are possible but rare by design)
    const randomValues = [0, 0.25, 0.5, 0.9999999]
    const randomSpy = vi.spyOn(Math, 'random')
    for (const value of randomValues) {
      randomSpy.mockReturnValueOnce(value)
    }

    const cursors: number[] = []
    try {
      for (const [i] of randomValues.entries()) {
        const result = await service.pushAutomergeSyncBatch({
          account: 'test-account',
          messages: [{
            itemId: 'item-1' as ItemId,
            encryptedMessage: { iv: `iv-${i}`, cipher: `c-${i}` },
          }],
        })
        cursors.push(result.results[0].cursor)
      }
    } finally {
      randomSpy.mockRestore()
    }

    expect(new Set(cursors).size).toBe(randomValues.length)
    // The zero offset is the start of the second's namespace; every other offset stays inside it
    const secondStart = cursors[0]
    expect(secondStart % 10_000_000).toBe(0)
    for (const cursor of cursors) {
      expect(cursor).toBeGreaterThanOrEqual(secondStart)
      expect(cursor).toBeLessThan(secondStart + 10_000_000)
    }
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

  it('passes the page token through when continuing the pagination of an item', async () => {
    const repository = createMockRepository()
    repository.getSyncMessages.mockResolvedValueOnce({
      messages: [],
      hasMore: false,
    })
    const service = createAutomergeSyncService({ repository })

    await service.pullAutomergeSyncBatch({
      account: 'test-account',
      cursors: [{ itemId: 'item-1' as ItemId, cursor: 150_000_199, pageToken: 'item-1-token' }],
    })

    expect(repository.getSyncMessages).toHaveBeenCalledWith({
      account: 'test-account',
      itemId: 'item-1',
      fromCursor: 150_000_199, // Must NOT subtract OVERLAP_CURSOR_DELTA
      pageToken: 'item-1-token',
      limit: 200,
    })
  })

  it('passes the page token through when continuing the global pagination', async () => {
    const repository = {
      ...createMockRepository(),
      getGlobalSyncMessagesAfterCursor: vi.fn().mockResolvedValueOnce({
        items: [],
        hasMore: false,
        scannedThroughCursor: 200_000_999,
      }),
    } as unknown as Mocked<AutomergeSyncRepository>
    const service = createAutomergeSyncService({ repository })

    await service.pullAutomergeSyncGlobal({
      account: 'test-account',
      cursor: 200_000_999,
      pageToken: 'global-token',
    })

    expect(repository.getGlobalSyncMessagesAfterCursor).toHaveBeenCalledWith({
      account: 'test-account',
      cursor: 200_000_999, // Must NOT subtract OVERLAP_CURSOR_DELTA
      pageToken: 'global-token',
    })
  })

  it('terminates pagination cleanly on burst writes across pages without looping', async () => {
    const repository = createMockRepository()
    const page1Token = 'item-1-page-1'
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
      nextPageToken: page1Token,
    })

    const service = createAutomergeSyncService({ repository })

    const page1Result = await service.pullAutomergeSyncBatch({
      account: 'test-account',
      cursors: [{ itemId: 'item-1' as ItemId, cursor: 100_000_000 }],
    })

    expect(page1Result.results[0].hasMore).toBe(true)
    expect(page1Result.results[0].nextPageToken).toEqual(page1Token)
    expect(page1Result.results[0].messages).toHaveLength(200)
    expect(repository.getSyncMessages).toHaveBeenLastCalledWith({
      account: 'test-account',
      itemId: 'item-1',
      fromCursor: 100_000_000,
      limit: 200,
      pageToken: undefined,
    })

    // Page 2: continuation with the page token
    repository.getSyncMessages.mockResolvedValueOnce({
      messages: page2Messages,
      hasMore: false,
    })

    const page2Result = await service.pullAutomergeSyncBatch({
      account: 'test-account',
      cursors: [{
        itemId: 'item-1' as ItemId,
        cursor: page1Result.results[0].nextCursor,
        pageToken: page1Result.results[0].nextPageToken,
      }],
    })

    expect(page2Result.results[0].hasMore).toBe(false)
    expect(page2Result.results[0].nextPageToken).toBeUndefined()
    expect(page2Result.results[0].messages).toHaveLength(50)
    expect(repository.getSyncMessages).toHaveBeenLastCalledWith({
      account: 'test-account',
      itemId: 'item-1',
      fromCursor: page1Result.results[0].nextCursor,
      limit: 200,
      pageToken: page1Token,
    })
  })

  it('returns fromCursor as nextCursor when no new messages exist (client is caught up)', async () => {
    const repository = createMockRepository()
    repository.getSyncMessages.mockResolvedValueOnce({
      messages: [],
      hasMore: false,
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
      pageToken: undefined,
    })
  })

  it('returns the scan position of a global continuation', async () => {
    const repository = createMockRepository()
    repository.getGlobalSyncMessagesAfterCursor = vi.fn().mockResolvedValueOnce({
      items: [],
      hasMore: false,
      scannedThroughCursor: 999,
    })
    const service = createAutomergeSyncService({ repository })

    const result = await service.pullAutomergeSyncGlobal({
      account: 'test-account',
      cursor: 1000,
      pageToken: 'global-token',
    })

    expect(result.scannedThroughCursor).toBe(999)
  })

  describe('concurrency control in pullAutomergeSyncBatch', () => {
    it('limits peak concurrent DynamoDB queries to DEFAULT_PULL_BATCH_CONCURRENCY by default', async () => {
      const repository = createMockRepository()
      let activeCount = 0
      let peakConcurrency = 0

      repository.getSyncMessages.mockImplementation(async () => {
        activeCount += 1
        peakConcurrency = Math.max(peakConcurrency, activeCount)
        await new Promise(resolve => setTimeout(resolve, 15))
        activeCount -= 1
        return { messages: [], hasMore: false }
      })

      const service = createAutomergeSyncService({ repository })
      const cursors = Array.from({ length: 30 }, (_, i) => ({
        itemId: `item-${i}` as ItemId,
        cursor: 100,
      }))

      const result = await service.pullAutomergeSyncBatch({
        account: 'test-account',
        cursors,
      })

      expect(result.success).toBe(true)
      expect(result.results).toHaveLength(30)
      expect(repository.getSyncMessages).toHaveBeenCalledTimes(30)
      expect(peakConcurrency).toBe(DEFAULT_PULL_BATCH_CONCURRENCY)
    })

    it('respects service-level pullConcurrency override', async () => {
      const repository = createMockRepository()
      let activeCount = 0
      let peakConcurrency = 0

      repository.getSyncMessages.mockImplementation(async () => {
        activeCount += 1
        peakConcurrency = Math.max(peakConcurrency, activeCount)
        await new Promise(resolve => setTimeout(resolve, 15))
        activeCount -= 1
        return { messages: [], hasMore: false }
      })

      const service = createAutomergeSyncService({ repository, pullConcurrency: 4 })
      const cursors = Array.from({ length: 15 }, (_, i) => ({
        itemId: `item-${i}` as ItemId,
        cursor: 100,
      }))

      const result = await service.pullAutomergeSyncBatch({
        account: 'test-account',
        cursors,
      })

      expect(result.success).toBe(true)
      expect(result.results).toHaveLength(15)
      expect(repository.getSyncMessages).toHaveBeenCalledTimes(15)
      expect(peakConcurrency).toBe(4)
    })

    it('respects input-level concurrency override over service default', async () => {
      const repository = createMockRepository()
      let activeCount = 0
      let peakConcurrency = 0

      repository.getSyncMessages.mockImplementation(async () => {
        activeCount += 1
        peakConcurrency = Math.max(peakConcurrency, activeCount)
        await new Promise(resolve => setTimeout(resolve, 15))
        activeCount -= 1
        return { messages: [], hasMore: false }
      })

      const service = createAutomergeSyncService({ repository, pullConcurrency: 8 })
      const cursors = Array.from({ length: 10 }, (_, i) => ({
        itemId: `item-${i}` as ItemId,
        cursor: 100,
      }))

      const result = await service.pullAutomergeSyncBatch({
        account: 'test-account',
        cursors,
        concurrency: 2,
      })

      expect(result.success).toBe(true)
      expect(result.results).toHaveLength(10)
      expect(peakConcurrency).toBe(2)
    })

    it('preserves result order even when requests resolve out of order', async () => {
      const repository = createMockRepository()

      repository.getSyncMessages.mockImplementation(async ({ itemId }: { itemId: ItemId }) => {
        const index = parseInt(itemId.replace('item-', ''), 10)
        const delay = (10 - index) * 5
        await new Promise(resolve => setTimeout(resolve, delay))
        return {
          messages: [{
            cursor: index * 10,
            encryptedMessage: { iv: `iv-${index}`, cipher: `c-${index}` },
            createdAt: 1000 + index,
          }],
          hasMore: false,
        }
      })

      const service = createAutomergeSyncService({ repository, pullConcurrency: 5 })
      const cursors = Array.from({ length: 10 }, (_, i) => ({
        itemId: `item-${i}` as ItemId,
        cursor: i * 10,
      }))

      const result = await service.pullAutomergeSyncBatch({
        account: 'test-account',
        cursors,
      })

      expect(result.results).toHaveLength(10)
      result.results.forEach((itemResult, i) => {
        expect(itemResult.itemId).toBe(`item-${i}`)
        expect(itemResult.messages[0].cursor).toBe(i * 10)
      })
    })

    it('propagates error and halts further worker iterations without unhandled rejection', async () => {
      const repository = createMockRepository()
      let queryCount = 0

      repository.getSyncMessages.mockImplementation(async ({ itemId }: { itemId: ItemId }) => {
        queryCount += 1
        if (itemId === 'item-2') {
          throw new Error('DynamoDB query failed for item-2')
        }
        await new Promise(resolve => setTimeout(resolve, 10))
        return { messages: [], hasMore: false }
      })

      const service = createAutomergeSyncService({ repository, pullConcurrency: 2 })
      const cursors = Array.from({ length: 10 }, (_, i) => ({
        itemId: `item-${i}` as ItemId,
        cursor: 100,
      }))

      await expect(
        service.pullAutomergeSyncBatch({
          account: 'test-account',
          cursors,
        })
      ).rejects.toThrow('DynamoDB query failed for item-2')

      expect(queryCount).toBeLessThan(10)
    })
  })

  describe('mapWithConcurrency', () => {
    it('returns empty array when input is empty', async () => {
      const fn = vi.fn()
      const result = await mapWithConcurrency([], 5, fn)
      expect(result).toEqual([])
      expect(fn).not.toHaveBeenCalled()
    })

    it('processes all items when concurrency is larger than item count', async () => {
      const result = await mapWithConcurrency([1, 2, 3], 10, async x => x * 2)
      expect(result).toEqual([2, 4, 6])
    })

    it('works correctly with concurrency = 1 (strictly serial)', async () => {
      const callLog: number[] = []
      const result = await mapWithConcurrency([1, 2, 3], 1, async x => {
        callLog.push(x)
        return x * 10
      })
      expect(callLog).toEqual([1, 2, 3])
      expect(result).toEqual([10, 20, 30])
    })
  })
})

