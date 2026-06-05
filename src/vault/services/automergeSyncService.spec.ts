import type { Mocked } from 'vitest'
import { createAutomergeSyncService } from './automergeSyncService'
import type { AutomergeSyncRepository } from './automergeSyncRepository'

describe('AutomergeSyncService', () => {
  const CUSTOM_EPOCH = 1760000000000 // 2026-01-01T00:00:00.000Z
  const TIMESTAMP_MULTIPLIER = 10_000_000

  const createMockRepository = () => {
    return {
      appendSyncMessage: vi.fn(),
      pushSyncMessagesBatch: vi.fn(),
      getSyncMessages: vi.fn(),
      pruneSyncMessagesUpToCursor: vi.fn(),
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
      { itemId: 'item-1', encryptedMessage: { iv: 'iv1', cipher: 'c1' } },
      { itemId: 'item-1', encryptedMessage: { iv: 'iv2', cipher: 'c2' } },
      { itemId: 'item-1', encryptedMessage: { iv: 'iv3', cipher: 'c3' } },
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
        { itemId: 'item-1', encryptedMessage: { iv: 'iv1', cipher: 'c1' } },
        { itemId: 'item-1', encryptedMessage: { iv: 'iv2', cipher: 'c2' } },
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
      messages: [{ itemId: 'item-1', encryptedMessage: { iv: 'iv1', cipher: 'c1' } }],
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
        messages: [{ itemId: 'item-1', encryptedMessage: { iv: `iv-${i}`, cipher: `c-${i}` } }],
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
      itemId: 'item-1',
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
})
