import { interpretAsDocumentId } from '@automerge/automerge-repo/slim'
import localforage from 'localforage'

import { SyncPullQueueManager } from './SyncPullQueueManager'
import { toAutomergeUrlFromItemId } from './utils/automerge'
import type { PullSyncMessagesResponse } from 'src/api/vault/SyncWorkerClient'
import { ItemId } from 'src/shared/schemas/items'
import { CursorStore } from './stores/CursorStore'

// Create a robust MockLocalforage helper class
class MockLocalforage {
  store = new Map<string, any>()
  getItem = vi.fn().mockImplementation(async (key: string) => this.store.get(key) ?? null)
  setItem = vi.fn().mockImplementation(async (key: string, value: any) => {
    this.store.set(key, value)
    return value
  })

  removeItem = vi.fn().mockImplementation(async (key: string) => {
    this.store.delete(key)
  })

  clear = vi.fn().mockImplementation(async () => {
    this.store.clear()
  })

  keys = vi.fn().mockImplementation(async () => Array.from(this.store.keys()))
  length = vi.fn().mockImplementation(async () => this.store.size)
  iterate = vi.fn().mockImplementation(async (fn: (val: any, key: string) => void) => {
    for (const [key, val] of this.store.entries()) {
      fn(val, key)
    }
  })
}

// Mock localforage
let activeStore: MockLocalforage | null = null
vi.mock('localforage', () => ({
  default: {
    createInstance: vi.fn().mockImplementation(() => {
      activeStore = new MockLocalforage()
      return activeStore
    }),
  },
}))

// Mock other dependencies
const mockDecryptBytes = vi.fn()
vi.mock('src/api/vault', () => ({
  decryptBytes: (...args: any[]) => mockDecryptBytes(...args),
}))

const mockPublishRealtimeBusSyncPing = vi.fn()
vi.mock('../client/realtimeBus', () => ({
  publishRealtimeBusSyncPing: (...args: any[]) => mockPublishRealtimeBusSyncPing(...args),
}))

const mockReportQuotaExceeded = vi.fn()
vi.mock('../../utils/storageManager', () => ({
  runStorageOperation: vi.fn(async (op: any) => {
    try {
      return await op()
    } catch (error: any) {
      const name = error?.name || ''
      const message = error?.message || ''
      if (
        name === 'QuotaExceededError' ||
        name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
        message.includes('QuotaExceededError') ||
        message.includes('quota exceeded')
      ) {
        mockReportQuotaExceeded()
      }
      throw error
    }
  }),
  reportQuotaExceeded: (...args: any[]) => mockReportQuotaExceeded(...args),
}))

vi.mock('./utils/automerge', async importOriginal => {
  const actual = await importOriginal<typeof import('./utils/automerge')>()
  return {
    ...actual,
    toAutomergeUrlFromItemId: (itemId: ItemId) => {
      if (itemId === 'item-throw-error') {
        throw new Error('Failed to resolve URL')
      }
      return actual.toAutomergeUrlFromItemId(itemId)
    },
  }
})


describe('SyncPullQueueManager', () => {
  let manager: SyncPullQueueManager
  let cursorStore: CursorStore

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    activeStore = null
    cursorStore = new CursorStore('account-1')
    manager = new SyncPullQueueManager(cursorStore)

    // Default mock behavior
    mockDecryptBytes.mockImplementation(async (encrypted: any) => encrypted.cipher)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('setAccount', () => {
    it('sets the account and loads cursors if set', async () => {
      await manager.setAccount('account-1')
      expect(activeStore).not.toBeNull()
      expect(activeStore?.getItem).toHaveBeenCalledWith('cursorByItemId')
    })

    it('clears maps and ignores store loading if account is null', async () => {
      activeStore = null
      manager.addPendingItem('item-1' as ItemId)
      await manager.setAccount(null)
      expect(manager.hasPendingPulls()).toBe(false)
      expect(activeStore).toBeNull()
    })

    it('loads previously stored cursors successfully', async () => {
      // Setup legacy mock item store pre-loaded values
      const preLoadedCursors: [string, number][] = [['item-1', 42]]
      const lf = new MockLocalforage()
      await lf.setItem('cursorByItemId', preLoadedCursors)

      // Inject this store into createInstance
      vi.mocked(localforage.createInstance).mockReturnValueOnce(lf as any)

      cursorStore = new CursorStore('account-2')
      manager = new SyncPullQueueManager(cursorStore)
      await manager.setAccount('account-2')
      expect(manager.exportCursors()).toEqual(preLoadedCursors)
    })
  })

  describe('pending items management', () => {
    it('manages pending items correctly', async () => {
      expect(manager.hasPendingPulls()).toBe(false)

      manager.addPendingItem('item-1' as ItemId)
      manager.addPendingItem('' as ItemId) // should be ignored

      expect(manager.hasPendingPulls()).toBe(true)

      await manager.shutdown()
      expect(manager.hasPendingPulls()).toBe(false)
    })
  })

  describe('getAllCursors', () => {
    it('includes cursors only for pending items', async () => {
      await manager.setAccount('account-1')

      // Add multiple cursors to internal state
      await manager.importCursors([
        ['item-1' as ItemId, 10],
        ['item-2' as ItemId, 20],
      ])

      // Since none are pending yet, cursors should be empty
      let cursors = manager.getCursors()
      expect(cursors).toHaveLength(0)

      // Add pending items
      manager.addPendingItem('item-1' as ItemId)
      manager.addPendingItem('item-2' as ItemId)
      cursors = manager.getCursors()

      expect(cursors).toHaveLength(2)
      expect(cursors).toContainEqual({ itemId: 'item-1', cursor: 10 })
      expect(cursors).toContainEqual({ itemId: 'item-2', cursor: 20 })
    })
  })

  describe('processPullResults', () => {
    beforeEach(async () => {
      await manager.setAccount('account-1')
    })

    it('parses single unbatched message', async () => {
      const onMessageParsedSpy = vi.fn()
      manager.onMessageParsed = onMessageParsedSpy
      mockDecryptBytes.mockResolvedValueOnce(new Uint8Array([1, 2, 3]))

      const pullResults: PullSyncMessagesResponse[] = [
        {
          success: true,
          itemId: 'item-1' as ItemId,
          hasMore: false,
          nextCursor: 5,
          messages: [
            {
              cursor: 2,
              encryptedMessage: {
                iv: 'iv-1',
                cipher: 'abc',
              },
            },
          ],
        },
      ]

      await manager.processPullResults(pullResults)

      const expectedDocId = interpretAsDocumentId(
        toAutomergeUrlFromItemId('item-1' as ItemId)
      )
      expect(onMessageParsedSpy).toHaveBeenCalledWith(
        'item-1',
        expectedDocId,
        new Uint8Array([1, 2, 3]),
      )

      expect(manager.exportCursors()).toContainEqual(['item-1', 5])
      expect(mockPublishRealtimeBusSyncPing).toHaveBeenCalledWith(['item-1'])

      // Check debounce persistence
      await vi.advanceTimersByTimeAsync(1000)
      expect(activeStore?.setItem).toHaveBeenCalledWith('cursorByItemId', [['item-1', 5]])
    })

    it('parses batched v1.0 messages with DataView length prefixes', async () => {
      const onMessageParsedSpy = vi.fn()
      manager.onMessageParsed = onMessageParsedSpy

      // Generate batched payload
      const msg1 = new Uint8Array([10, 20, 30])
      const msg2 = new Uint8Array([40, 50])
      const combined = new Uint8Array(4 + msg1.length + 4 + msg2.length)
      const view = new DataView(combined.buffer)

      let offset = 0
      view.setUint32(offset, msg1.length, false)
      offset += 4
      combined.set(msg1, offset)
      offset += msg1.length

      view.setUint32(offset, msg2.length, false)
      offset += 4
      combined.set(msg2, offset)

      mockDecryptBytes.mockResolvedValueOnce(combined)

      const pullResults: PullSyncMessagesResponse[] = [
        {
          success: true,
          itemId: 'item-2' as ItemId,
          hasMore: true, // Should mark as pending
          nextCursor: 15,
          messages: [
            {
              cursor: 12,
              encryptedMessage: {
                iv: 'iv-batch',
                cipher: 'abc',
                version: '1.0',
              },
            },
          ],
        },
      ]

      await manager.processPullResults(pullResults)

      const expectedDocId = interpretAsDocumentId(
        toAutomergeUrlFromItemId('item-2' as ItemId)
      )
      expect(onMessageParsedSpy).toHaveBeenCalledTimes(2)
      expect(onMessageParsedSpy).toHaveBeenNthCalledWith(
        1,
        'item-2',
        expectedDocId,
        msg1,
      )
      expect(onMessageParsedSpy).toHaveBeenNthCalledWith(
        2,
        'item-2',
        expectedDocId,
        msg2,
      )

      expect(manager.exportCursors()).toContainEqual(['item-2', 15])
      expect(manager.hasPendingPulls()).toBe(true) // because hasMore was true
    })

    it('keeps item in pending pull queue on parse failure for attempts 1-4', async () => {
      const mockOnDecryptionFailure = vi.fn()
      manager.onDecryptionFailure = mockOnDecryptionFailure
      mockDecryptBytes.mockRejectedValue(new Error('Decryption failed'))

      const pullResults: PullSyncMessagesResponse[] = [
        {
          success: true,
          itemId: 'item-fail' as ItemId,
          hasMore: false,
          nextCursor: 20,
          messages: [
            {
              cursor: 10,
              encryptedMessage: {
                iv: 'iv-fail',
                cipher: 'abc',
              },
            },
          ],
        },
      ]

      // Attempts 1 to 4
      for (let attempt = 1; attempt <= 4; attempt++) {
        await manager.processPullResults(pullResults)
        expect(mockOnDecryptionFailure).not.toHaveBeenCalled()
        expect(manager.hasPendingPulls()).toBe(true)
        expect(manager.getCursors()).toContainEqual({ itemId: 'item-fail', cursor: 0 })
      }
    })

    it('removes item from queue and triggers onDecryptionFailure on 5th consecutive failure', async () => {
      const mockOnDecryptionFailure = vi.fn()
      manager.onDecryptionFailure = mockOnDecryptionFailure
      mockDecryptBytes.mockRejectedValue(new Error('Decryption failed'))

      const pullResults: PullSyncMessagesResponse[] = [
        {
          success: true,
          itemId: 'item-fail-5' as ItemId,
          hasMore: false,
          nextCursor: 20,
          messages: [
            {
              cursor: 10,
              encryptedMessage: {
                iv: 'iv-fail',
                cipher: 'abc',
              },
            },
          ],
        },
      ]

      // Run 5 attempts
      for (let attempt = 1; attempt <= 5; attempt++) {
        await manager.processPullResults(pullResults)
      }

      expect(mockOnDecryptionFailure).toHaveBeenCalledTimes(1)
      expect(mockOnDecryptionFailure).toHaveBeenCalledWith(
        'item-fail-5',
        expect.objectContaining({
          message: expect.stringContaining('Permanently failed to parse sync messages after 5 attempts'),
        })
      )
      expect(manager.hasPendingPulls()).toBe(false)
      expect(manager.exportCursors()).toContainEqual(['item-fail-5', 10])
    })

    it('advances cursor past corrupted message on 5th failure and prevents infinite retry loop on subsequent polls', async () => {
      const mockOnDecryptionFailure = vi.fn()
      manager.onDecryptionFailure = mockOnDecryptionFailure
      mockDecryptBytes.mockRejectedValue(new Error('Decryption failed'))

      const pullResults: PullSyncMessagesResponse[] = [
        {
          success: true,
          itemId: 'item-infinite-loop' as ItemId,
          hasMore: false,
          nextCursor: 10,
          messages: [
            {
              cursor: 10,
              encryptedMessage: {
                iv: 'iv-fail',
                cipher: 'abc',
              },
            },
          ],
        },
      ]

      // Attempts 1 to 4: cursor remains 0, pending remains true
      for (let attempt = 1; attempt <= 4; attempt++) {
        await manager.processPullResults(pullResults)
        expect(manager.exportCursors()).toContainEqual(['item-infinite-loop', 0])
        expect(manager.hasPendingPulls()).toBe(true)
        expect(mockOnDecryptionFailure).not.toHaveBeenCalled()
      }

      // Attempt 5: permanently fails, invokes onDecryptionFailure, advances cursor to 10
      await manager.processPullResults(pullResults)
      expect(mockOnDecryptionFailure).toHaveBeenCalledTimes(1)
      expect(manager.exportCursors()).toContainEqual(['item-infinite-loop', 10])
      expect(manager.hasPendingPulls()).toBe(false)

      // Subsequent poll (attempt 6) receives the same corrupted message (e.g. via overlap window query)
      // The message is recognized as seen/skipped and does NOT re-trigger the 5-retry failure cycle
      await manager.processPullResults(pullResults)
      expect(mockOnDecryptionFailure).toHaveBeenCalledTimes(1)
      expect(manager.hasPendingPulls()).toBe(false)
      expect(manager.exportCursors()).toContainEqual(['item-infinite-loop', 10])
    })

    it('falls back to nextCursor when message cursor is omitted on 5th failure', async () => {
      const mockOnDecryptionFailure = vi.fn()
      manager.onDecryptionFailure = mockOnDecryptionFailure
      mockDecryptBytes.mockRejectedValue(new Error('Decryption failed'))

      const pullResults: PullSyncMessagesResponse[] = [
        {
          success: true,
          itemId: 'item-no-msg-cursor' as ItemId,
          hasMore: false,
          nextCursor: 25,
          messages: [
            {
              encryptedMessage: {
                iv: 'iv-fail',
                cipher: 'abc',
              },
            },
          ],
        },
      ]

      for (let attempt = 1; attempt <= 5; attempt++) {
        await manager.processPullResults(pullResults)
      }

      expect(mockOnDecryptionFailure).toHaveBeenCalledTimes(1)
      expect(manager.exportCursors()).toContainEqual(['item-no-msg-cursor', 25])
      expect(manager.hasPendingPulls()).toBe(false)
    })

    it('resets retry counter on successful message parse', async () => {
      const mockOnDecryptionFailure = vi.fn()
      manager.onDecryptionFailure = mockOnDecryptionFailure

      const failResults: PullSyncMessagesResponse[] = [
        {
          success: true,
          itemId: 'item-recover' as ItemId,
          hasMore: false,
          nextCursor: 20,
          messages: [
            {
              cursor: 10,
              encryptedMessage: {
                iv: 'iv-fail',
                cipher: 'abc',
              },
            },
          ],
        },
      ]

      // Fail 3 times
      mockDecryptBytes.mockRejectedValue(new Error('Decryption failed'))
      for (let attempt = 1; attempt <= 3; attempt++) {
        await manager.processPullResults(failResults)
      }
      expect(manager.hasPendingPulls()).toBe(true)

      // 4th time succeeds
      mockDecryptBytes.mockResolvedValueOnce(new Uint8Array([1, 2, 3]))
      const successResults: PullSyncMessagesResponse[] = [
        {
          success: true,
          itemId: 'item-recover' as ItemId,
          hasMore: false,
          nextCursor: 20,
          messages: [
            {
              cursor: 10,
              encryptedMessage: {
                iv: 'iv-success',
                cipher: 'xyz',
              },
            },
          ],
        },
      ]
      await manager.processPullResults(successResults)
      expect(manager.hasPendingPulls()).toBe(false)

      // Now failing again should start from attempt 1 (requiring 5 more failures to quarantine)
      mockDecryptBytes.mockRejectedValue(new Error('Decryption failed again'))
      for (let attempt = 1; attempt <= 4; attempt++) {
        await manager.processPullResults(failResults)
        expect(mockOnDecryptionFailure).not.toHaveBeenCalled()
      }
    })

    it('clears retry counter on shutdown and setAccount', async () => {
      const mockOnDecryptionFailure = vi.fn()
      manager.onDecryptionFailure = mockOnDecryptionFailure
      mockDecryptBytes.mockRejectedValue(new Error('Decryption failed'))

      const failResults: PullSyncMessagesResponse[] = [
        {
          success: true,
          itemId: 'item-clear' as ItemId,
          hasMore: false,
          nextCursor: 20,
          messages: [
            {
              cursor: 10,
              encryptedMessage: {
                iv: 'iv-fail',
                cipher: 'abc',
              },
            },
          ],
        },
      ]

      // Fail 4 times on account-1
      for (let attempt = 1; attempt <= 4; attempt++) {
        await manager.processPullResults(failResults)
      }

      // Switch account resets retry counts
      await manager.setAccount('account-new')
      expect(manager.hasPendingPulls()).toBe(false)

      // 1 failure should not trigger max retry (5)
      await manager.processPullResults(failResults)
      expect(mockOnDecryptionFailure).not.toHaveBeenCalled()

      // Shutdown also clears
      await manager.shutdown()
      await manager.setAccount('account-new')
      await manager.processPullResults(failResults)
      expect(mockOnDecryptionFailure).not.toHaveBeenCalled()
    })

    it('skips processing already seen messages (overlap window dedup)', async () => {
      const onMessageParsedSpy = vi.fn()
      manager.onMessageParsed = onMessageParsedSpy
      mockDecryptBytes.mockResolvedValue(new Uint8Array([1, 2, 3]))

      const batch1: PullSyncMessagesResponse[] = [
        {
          success: true,
          itemId: 'item-dedup' as ItemId,
          hasMore: true,
          nextCursor: 20,
          messages: [
            {
              cursor: 10,
              encryptedMessage: {
                iv: 'iv-1',
                cipher: 'msg1',
              },
            },
            {
              cursor: 20,
              encryptedMessage: {
                iv: 'iv-2',
                cipher: 'msg2',
              },
            },
          ],
        },
      ]

      await manager.processPullResults(batch1)
      expect(onMessageParsedSpy).toHaveBeenCalledTimes(2)

      // Batch 2 pulls overlap window starting before cursor 20
      const batch2: PullSyncMessagesResponse[] = [
        {
          success: true,
          itemId: 'item-dedup' as ItemId,
          hasMore: false,
          nextCursor: 30,
          messages: [
            {
              cursor: 20, // Already seen!
              encryptedMessage: {
                iv: 'iv-2',
                cipher: 'msg2',
              },
            },
            {
              cursor: 30, // New!
              encryptedMessage: {
                iv: 'iv-3',
                cipher: 'msg3',
              },
            },
          ],
        },
      ]

      await manager.processPullResults(batch2)
      // Only 1 additional message should be processed
      expect(onMessageParsedSpy).toHaveBeenCalledTimes(3)
    })

    it('advances cursor when batch consists entirely of seen messages and server omits nextCursor', async () => {
      const onMessageParsedSpy = vi.fn()
      manager.onMessageParsed = onMessageParsedSpy
      mockDecryptBytes.mockResolvedValue(new Uint8Array([1, 2, 3]))

      // First, process messages with cursor 10 and 20 to populate seenMessageCursors
      await manager.processPullResults([
        {
          success: true,
          itemId: 'item-stagnate' as ItemId,
          hasMore: false,
          messages: [
            {
              cursor: 10,
              encryptedMessage: {
                iv: 'iv-1',
                cipher: 'msg1',
              },
            },
            {
              cursor: 20,
              encryptedMessage: {
                iv: 'iv-2',
                cipher: 'msg2',
              },
            },
          ],
        },
      ])

      expect(manager.exportCursors()).toContainEqual(['item-stagnate', 20])

      // Simulate state cursor being lower (e.g. from stored state or retry with lower cursor)
      await manager.importCursors([['item-stagnate' as ItemId, 5]])
      expect(manager.exportCursors()).toContainEqual(['item-stagnate', 5])

      // Receive a batch consisting entirely of seen messages with nextCursor omitted
      await manager.processPullResults([
        {
          success: true,
          itemId: 'item-stagnate' as ItemId,
          hasMore: false,
          messages: [
            {
              cursor: 10, // already seen
              encryptedMessage: {
                iv: 'iv-1',
                cipher: 'msg1',
              },
            },
            {
              cursor: 20, // already seen
              encryptedMessage: {
                iv: 'iv-2',
                cipher: 'msg2',
              },
            },
          ],
        },
      ])

      // Cursor should have advanced to 20 instead of remaining at 5
      expect(manager.exportCursors()).toContainEqual(['item-stagnate', 20])
    })

    it('evicts oldest seen message cache entries when exceeding SEEN_CACHE_MAX', async () => {
      const onMessageParsedSpy = vi.fn()
      manager.onMessageParsed = onMessageParsedSpy
      mockDecryptBytes.mockResolvedValue(new Uint8Array([1, 2, 3]))

      // Fill seen cache with 2001 messages
      const messages = []
      for (let i = 1; i <= 2001; i++) {
        messages.push({
          cursor: i,
          encryptedMessage: {
            iv: `iv-${i}`,
            cipher: `msg${i}`,
          },
        })
      }

      await manager.processPullResults([
        {
          success: true,
          itemId: 'item-cache' as ItemId,
          hasMore: false,
          nextCursor: 2001,
          messages,
        },
      ])

      expect(onMessageParsedSpy).toHaveBeenCalledTimes(2001)

      // Message with cursor 1 was evicted, so receiving it again will re-process it
      await manager.processPullResults([
        {
          success: true,
          itemId: 'item-cache' as ItemId,
          hasMore: false,
          nextCursor: 2001,
          messages: [
            {
              cursor: 1, // Was evicted
              encryptedMessage: {
                iv: 'iv-1',
                cipher: 'msg1',
              },
            },
            {
              cursor: 2001, // Still in cache
              encryptedMessage: {
                iv: 'iv-2001',
                cipher: 'msg2001',
              },
            },
          ],
        },
      ])

      // Only cursor 1 was reprocessed, cursor 2001 was skipped
      expect(onMessageParsedSpy).toHaveBeenCalledTimes(2002)
    })

    it('clears seen message cache on account change and shutdown', async () => {
      const onMessageParsedSpy = vi.fn()
      manager.onMessageParsed = onMessageParsedSpy
      mockDecryptBytes.mockResolvedValue(new Uint8Array([1, 2, 3]))

      const msg = {
        cursor: 10,
        encryptedMessage: {
          iv: 'iv-1',
          cipher: 'msg1',
        },
      }

      await manager.processPullResults([
        {
          success: true,
          itemId: 'item-1' as ItemId,
          hasMore: false,
          nextCursor: 10,
          messages: [msg],
        },
      ])
      expect(onMessageParsedSpy).toHaveBeenCalledTimes(1)

      // Re-running on same account skips it
      await manager.processPullResults([
        {
          success: true,
          itemId: 'item-1' as ItemId,
          hasMore: false,
          nextCursor: 10,
          messages: [msg],
        },
      ])
      expect(onMessageParsedSpy).toHaveBeenCalledTimes(1)

      // Change account
      await manager.setAccount('account-2')
      await manager.processPullResults([
        {
          success: true,
          itemId: 'item-1' as ItemId,
          hasMore: false,
          nextCursor: 10,
          messages: [msg],
        },
      ])
      expect(onMessageParsedSpy).toHaveBeenCalledTimes(2)
    })

    it('re-queues pending items and clears them based on hasMore', async () => {
      // First batch hasMore: true
      await manager.processPullResults([
        {
          success: true,
          itemId: 'item-x' as ItemId,
          hasMore: true,
          nextCursor: 100,
          messages: [],
        },
      ])
      expect(manager.hasPendingPulls()).toBe(true)

      // Second batch hasMore: false
      await manager.processPullResults([
        {
          success: true,
          itemId: 'item-x' as ItemId,
          hasMore: false,
          nextCursor: 105,
          messages: [],
        },
      ])
      expect(manager.hasPendingPulls()).toBe(false)
    })

    it('halts on message processing failure in a batch to preserve causal order and preserves item for retry', async () => {
      let failMessage1 = true
      const onMessageParsedSpy = vi.fn().mockImplementation((itemId, docId, msg) => {
        if (failMessage1 && msg[0] === 10) {
          throw new Error('Transient processing error for message 1')
        }
      })
      manager.onMessageParsed = onMessageParsedSpy

      const msg1 = new Uint8Array([10, 20, 30])
      const msg2 = new Uint8Array([40, 50])
      const combined = new Uint8Array(4 + msg1.length + 4 + msg2.length)
      const view = new DataView(combined.buffer)

      let offset = 0
      view.setUint32(offset, msg1.length, false)
      offset += 4
      combined.set(msg1, offset)
      offset += msg1.length

      view.setUint32(offset, msg2.length, false)
      offset += 4
      combined.set(msg2, offset)

      mockDecryptBytes.mockResolvedValue(combined)

      const pullResults: PullSyncMessagesResponse[] = [
        {
          success: true,
          itemId: 'item-batch-error' as ItemId,
          hasMore: false,
          nextCursor: 15,
          messages: [
            {
              cursor: 12,
              encryptedMessage: {
                iv: 'iv-batch',
                cipher: 'abc',
                version: '1.0',
              },
            },
          ],
        },
      ]

      // Attempt 1: Message 1 throws, halts immediately so message 2 is not applied out-of-order
      await manager.processPullResults(pullResults)

      const expectedDocId = interpretAsDocumentId(
        toAutomergeUrlFromItemId('item-batch-error' as ItemId)
      )
      expect(onMessageParsedSpy).toHaveBeenCalledTimes(1)
      expect(onMessageParsedSpy).toHaveBeenNthCalledWith(
        1,
        'item-batch-error',
        expectedDocId,
        msg1,
      )

      expect(manager.exportCursors()).toEqual([['item-batch-error', 0]])
      expect(manager.hasPendingPulls()).toBe(true)

      // Attempt 2 (retry): Transient failure resolved; both messages applied sequentially in batch order
      failMessage1 = false
      await manager.processPullResults(pullResults)

      expect(onMessageParsedSpy).toHaveBeenCalledTimes(3)
      expect(onMessageParsedSpy).toHaveBeenNthCalledWith(
        2,
        'item-batch-error',
        expectedDocId,
        msg1,
      )
      expect(onMessageParsedSpy).toHaveBeenNthCalledWith(
        3,
        'item-batch-error',
        expectedDocId,
        msg2,
      )
      expect(manager.exportCursors()).toEqual([['item-batch-error', 15]])
      expect(manager.hasPendingPulls()).toBe(false)
    })

    it('prevents duplicate processing of already succeeded inner messages when retrying a partially failed batch', async () => {
      let failMessage2 = true
      const onMessageParsedSpy = vi.fn().mockImplementation((itemId, docId, msg) => {
        if (failMessage2 && msg[0] === 40) {
          throw new Error('Transient processing error for message 2')
        }
      })
      manager.onMessageParsed = onMessageParsedSpy

      const msg1 = new Uint8Array([10, 20, 30])
      const msg2 = new Uint8Array([40, 50])
      const combined = new Uint8Array(4 + msg1.length + 4 + msg2.length)
      const view = new DataView(combined.buffer)

      let offset = 0
      view.setUint32(offset, msg1.length, false)
      offset += 4
      combined.set(msg1, offset)
      offset += msg1.length

      view.setUint32(offset, msg2.length, false)
      offset += 4
      combined.set(msg2, offset)

      mockDecryptBytes.mockResolvedValue(combined)

      const pullResults: PullSyncMessagesResponse[] = [
        {
          success: true,
          itemId: 'item-partial-retry' as ItemId,
          hasMore: false,
          nextCursor: 15,
          messages: [
            {
              cursor: 12,
              encryptedMessage: {
                iv: 'iv-batch',
                cipher: 'abc',
                version: '1.0',
              },
            },
          ],
        },
      ]

      const expectedDocId = interpretAsDocumentId(
        toAutomergeUrlFromItemId('item-partial-retry' as ItemId)
      )

      // Attempt 1: msg1 succeeds, msg2 fails
      await manager.processPullResults(pullResults)
      expect(onMessageParsedSpy).toHaveBeenCalledTimes(2)
      expect(onMessageParsedSpy).toHaveBeenNthCalledWith(1, 'item-partial-retry', expectedDocId, msg1)
      expect(onMessageParsedSpy).toHaveBeenNthCalledWith(2, 'item-partial-retry', expectedDocId, msg2)
      expect(manager.exportCursors()).toEqual([['item-partial-retry', 0]])
      expect(manager.hasPendingPulls()).toBe(true)

      // Attempt 2 (retry): msg1 must NOT be re-applied; msg2 succeeds
      failMessage2 = false
      await manager.processPullResults(pullResults)
      // Only 1 additional call for msg2! (3 total, NOT 4)
      expect(onMessageParsedSpy).toHaveBeenCalledTimes(3)
      expect(onMessageParsedSpy).toHaveBeenNthCalledWith(3, 'item-partial-retry', expectedDocId, msg2)
      expect(manager.exportCursors()).toEqual([['item-partial-retry', 15]])
      expect(manager.hasPendingPulls()).toBe(false)
    })

    it('does not re-apply succeeded inner messages across 5 failed retries until quarantine', async () => {
      const onMessageParsedSpy = vi.fn().mockImplementation((itemId, docId, msg) => {
        if (msg[0] === 40) {
          throw new Error('Persistent failure for message 2')
        }
      })
      manager.onMessageParsed = onMessageParsedSpy
      const mockOnDecryptionFailure = vi.fn()
      manager.onDecryptionFailure = mockOnDecryptionFailure

      const msg1 = new Uint8Array([10, 20, 30])
      const msg2 = new Uint8Array([40, 50])
      const combined = new Uint8Array(4 + msg1.length + 4 + msg2.length)
      const view = new DataView(combined.buffer)

      let offset = 0
      view.setUint32(offset, msg1.length, false)
      offset += 4
      combined.set(msg1, offset)
      offset += msg1.length

      view.setUint32(offset, msg2.length, false)
      offset += 4
      combined.set(msg2, offset)

      mockDecryptBytes.mockResolvedValue(combined)

      const pullResults: PullSyncMessagesResponse[] = [
        {
          success: true,
          itemId: 'item-5-retries' as ItemId,
          hasMore: false,
          nextCursor: 15,
          messages: [
            {
              cursor: 12,
              encryptedMessage: {
                iv: 'iv-batch',
                cipher: 'abc',
                version: '1.0',
              },
            },
          ],
        },
      ]

      // 5 attempts
      for (let attempt = 1; attempt <= 5; attempt++) {
        await manager.processPullResults(pullResults)
      }

      // msg1 was executed ONCE (on attempt 1) and never re-applied on attempts 2-5!
      // msg2 was attempted 5 times (failed each time)
      // Total calls = 1 + 5 = 6
      expect(onMessageParsedSpy).toHaveBeenCalledTimes(6)
      const msg1Calls = onMessageParsedSpy.mock.calls.filter(call => call[2] === msg1 || (call[2] && call[2][0] === 10))
      expect(msg1Calls).toHaveLength(1)

      expect(mockOnDecryptionFailure).toHaveBeenCalledTimes(1)
      expect(mockOnDecryptionFailure).toHaveBeenCalledWith(
        'item-5-retries',
        expect.objectContaining({
          message: expect.stringContaining('Permanently failed to parse sync messages after 5 attempts'),
        })
      )
      expect(manager.hasPendingPulls()).toBe(false)
    })

    it('handles message processing error for non-batched message and preserves item for retry', async () => {
      const onMessageParsedSpy = vi.fn().mockImplementation(() => {
        throw new Error('Processing failed')
      })
      manager.onMessageParsed = onMessageParsedSpy

      mockDecryptBytes.mockResolvedValueOnce(new Uint8Array([1, 2, 3]))

      const pullResults: PullSyncMessagesResponse[] = [
        {
          success: true,
          itemId: 'item-1' as ItemId,
          hasMore: false,
          nextCursor: 5,
          messages: [
            {
              cursor: 2,
              encryptedMessage: {
                iv: 'iv-1',
                cipher: 'abc',
              },
            },
          ],
        },
      ]

      await expect(manager.processPullResults(pullResults)).resolves.not.toThrow()
      expect(manager.exportCursors()).toEqual([['item-1', 0]])
      expect(manager.hasPendingPulls()).toBe(true)
    })

    it('stops processing messages and preserves cursor before failed message when a parse failure occurs mid-batch and keeps item for retry', async () => {
      const onMessageParsedSpy = vi.fn()
      manager.onMessageParsed = onMessageParsedSpy

      mockDecryptBytes
        .mockResolvedValueOnce(new Uint8Array([1]))
        .mockRejectedValueOnce(new Error('Decryption failed for message 2'))

      const pullResults: PullSyncMessagesResponse[] = [
        {
          success: true,
          itemId: 'item-partial' as ItemId,
          hasMore: false,
          nextCursor: 50,
          messages: [
            {
              cursor: 10,
              encryptedMessage: {
                iv: 'iv-1',
                cipher: 'abc',
              },
            },
            {
              cursor: 20,
              encryptedMessage: {
                iv: 'iv-2',
                cipher: 'def',
              },
            },
            {
              cursor: 30,
              encryptedMessage: {
                iv: 'iv-3',
                cipher: 'ghi',
              },
            },
          ],
        },
      ]

      await manager.processPullResults(pullResults)

      expect(onMessageParsedSpy).toHaveBeenCalledTimes(1)
      expect(mockDecryptBytes).toHaveBeenCalledTimes(2)
      expect(manager.exportCursors()).toEqual([['item-partial', 10]])
      expect(manager.hasPendingPulls()).toBe(true)
    })

    it('keeps pending pull item when parse failure occurs even if hasMore is true', async () => {
      mockDecryptBytes.mockRejectedValueOnce(new Error('Corrupt ciphertext'))

      const pullResults: PullSyncMessagesResponse[] = [
        {
          success: true,
          itemId: 'item-corrupt-hasmore' as ItemId,
          hasMore: true,
          nextCursor: 50,
          messages: [
            {
              cursor: 10,
              encryptedMessage: {
                iv: 'iv-corrupt',
                cipher: 'bad-payload',
              },
            },
          ],
        },
      ]

      await manager.processPullResults(pullResults)

      expect(manager.exportCursors()).toEqual([['item-corrupt-hasmore', 0]])
      expect(manager.hasPendingPulls()).toBe(true)
    })

    it('continues processing subsequent items if one item throws an error', async () => {
      const onMessageParsedSpy = vi.fn()
      manager.onMessageParsed = onMessageParsedSpy

      mockDecryptBytes.mockResolvedValue(new Uint8Array([1, 2, 3]))

      const pullResults: PullSyncMessagesResponse[] = [
        {
          success: true,
          itemId: 'item-throw-error' as ItemId,
          hasMore: false,
          nextCursor: 10,
          messages: [
            {
              cursor: 5,
              encryptedMessage: {
                iv: 'iv-1',
                cipher: 'abc',
              },
            },
          ],
        },
        {
          success: true,
          itemId: 'item-success' as ItemId,
          hasMore: false,
          nextCursor: 20,
          messages: [
            {
              cursor: 15,
              encryptedMessage: {
                iv: 'iv-2',
                cipher: 'def',
              },
            },
          ],
        },
      ]

      await expect(manager.processPullResults(pullResults)).resolves.not.toThrow()

      const expectedDocId = interpretAsDocumentId(toAutomergeUrlFromItemId('item-success' as ItemId))
      expect(onMessageParsedSpy).toHaveBeenCalledWith(
        'item-success',
        expectedDocId,
        new Uint8Array([1, 2, 3]),
      )

      expect(manager.exportCursors()).toContainEqual(['item-success', 20])
      expect(manager.exportCursors()).not.toContainEqual(['item-throw-error', 10])
    })

    it('does not advance cursor past failed message when batch contains out-of-order cursors', async () => {
      const onMessageParsedSpy = vi.fn()
      manager.onMessageParsed = onMessageParsedSpy

      // cursor 2 will fail, cursor 3 would succeed if reached
      mockDecryptBytes.mockImplementation(async (encrypted: any) => {
        if (encrypted.cipher === 'fail-msg2') {
          throw new Error('Decryption failed for cursor 2')
        }
        return new Uint8Array([3])
      })

      const pullResults: PullSyncMessagesResponse[] = [
        {
          success: true,
          itemId: 'item-out-of-order' as ItemId,
          hasMore: false,
          nextCursor: 5,
          messages: [
            {
              cursor: 3,
              encryptedMessage: {
                iv: 'iv-3',
                cipher: 'ok-msg3',
              },
            },
            {
              cursor: 2,
              encryptedMessage: {
                iv: 'iv-2',
                cipher: 'fail-msg2',
              },
            },
          ],
        },
      ]

      await manager.processPullResults(pullResults)

      // Cursor 2 must be processed first due to ascending sort; it fails immediately.
      // Cursor must NOT have advanced to 3, preserving cursor 0 for retry so cursor 2 is not skipped.
      expect(manager.exportCursors()).toEqual([['item-out-of-order', 0]])
      expect(manager.hasPendingPulls()).toBe(true)
      expect(manager.getCursors()).toEqual([{ itemId: 'item-out-of-order', cursor: 0 }])
      expect(onMessageParsedSpy).not.toHaveBeenCalled()
    })

    it('processes out-of-order messages in ascending cursor order', async () => {
      const processedCursors: number[] = []
      manager.onMessageParsed = (_itemId, _docId, msg) => {
        processedCursors.push(msg[0])
      }

      mockDecryptBytes.mockImplementation(async (encrypted: any) => {
        return new Uint8Array([encrypted.val])
      })

      const pullResults: PullSyncMessagesResponse[] = [
        {
          success: true,
          itemId: 'item-sort-order' as ItemId,
          hasMore: false,
          nextCursor: 35,
          messages: [
            { cursor: 30, encryptedMessage: { iv: 'iv-3', cipher: 'c3', val: 30 } as any },
            { cursor: 10, encryptedMessage: { iv: 'iv-1', cipher: 'c1', val: 10 } as any },
            { cursor: 20, encryptedMessage: { iv: 'iv-2', cipher: 'c2', val: 20 } as any },
          ],
        },
      ]

      await manager.processPullResults(pullResults)

      expect(processedCursors).toEqual([10, 20, 30])
      expect(manager.exportCursors()).toContainEqual(['item-sort-order', 35])
    })

    it('advances cursor to earlier successful message when higher out-of-order message fails', async () => {
      const onMessageParsedSpy = vi.fn()
      manager.onMessageParsed = onMessageParsedSpy

      mockDecryptBytes.mockImplementation(async (encrypted: any) => {
        if (encrypted.cipher === 'fail-msg30') {
          throw new Error('Decryption failed for cursor 30')
        }
        return new Uint8Array([20])
      })

      const pullResults: PullSyncMessagesResponse[] = [
        {
          success: true,
          itemId: 'item-partial-out-of-order' as ItemId,
          hasMore: false,
          nextCursor: 40,
          messages: [
            {
              cursor: 30,
              encryptedMessage: {
                iv: 'iv-30',
                cipher: 'fail-msg30',
              },
            },
            {
              cursor: 20,
              encryptedMessage: {
                iv: 'iv-20',
                cipher: 'ok-msg20',
              },
            },
          ],
        },
      ]

      await manager.processPullResults(pullResults)

      // Cursor 20 succeeds, cursor 30 fails.
      // Cursor should advance to 20, and item should remain pending to retry cursor 30.
      expect(onMessageParsedSpy).toHaveBeenCalledTimes(1)
      expect(manager.exportCursors()).toContainEqual(['item-partial-out-of-order', 20])
      expect(manager.hasPendingPulls()).toBe(true)
      expect(manager.getCursors()).toEqual([{ itemId: 'item-partial-out-of-order', cursor: 20 }])
    })
  })

  describe('processPushResults (B4 fix)', () => {
    beforeEach(async () => {
      await manager.setAccount('account-1')
    })

    it('does not advance pull cursor or clear pending status', async () => {
      await manager.importCursors([['item-y' as ItemId, 10]])
      manager.addPendingItem('item-y' as ItemId)

      // Push results arrive with higher cursor (e.g. cursor 50 assigned to this client's push)
      manager.processPushResults([{ itemId: 'item-y' as ItemId, cursor: 50 }])

      // Pull cursor MUST NOT jump forward to 50 (which would skip peer messages < 50)
      expect(manager.exportCursors()).toContainEqual(['item-y', 10])
      expect(manager.getGlobalLatestCursor()).toBe(10)

      // Pending pull status MUST NOT be cleared (which would kill pagination)
      expect(manager.hasPendingPulls()).toBe(true)
      expect(manager.getCursors()).toEqual([{ itemId: 'item-y', cursor: 10 }])
    })

    it('preserves multi-page pull pagination when push results arrive', async () => {
      // Step 1: Simulate a multi-page pull result where hasMore: true sets pending: true
      await manager.processPullResults([
        {
          success: true,
          itemId: 'item-page' as ItemId,
          messages: [
            {
              cursor: 100,
              encryptedMessage: { iv: 'iv1', cipher: 'c1', version: 'legacy' },
            },
          ],
          hasMore: true,
          nextCursor: 100,
        },
      ])

      expect(manager.hasPendingPulls()).toBe(true)
      expect(manager.getCursors()).toEqual([{ itemId: 'item-page', cursor: 100 }])

      // Step 2: Push results arrive (e.g. from an outbound push chunk)
      manager.processPushResults([{ itemId: 'item-page' as ItemId, cursor: 500 }])

      // Step 3: Pagination must still be alive (pending = true, cursor = 100)
      expect(manager.hasPendingPulls()).toBe(true)
      expect(manager.getCursors()).toEqual([{ itemId: 'item-page', cursor: 100 }])

      // Step 4: Next page can be pulled successfully
      await manager.processPullResults([
        {
          success: true,
          itemId: 'item-page' as ItemId,
          messages: [
            {
              cursor: 200,
              encryptedMessage: { iv: 'iv2', cipher: 'c2', version: 'legacy' },
            },
          ],
          hasMore: false,
          nextCursor: 200,
        },
      ])

      expect(manager.hasPendingPulls()).toBe(false)
      expect(manager.exportCursors()).toContainEqual(['item-page', 200])
    })

    it('marks pushed messages as seen so they are deduplicated when pulled', async () => {
      const onMessageParsedSpy = vi.fn()
      manager.onMessageParsed = onMessageParsedSpy

      // Client pushes a message and gets cursor 500
      manager.processPushResults([{ itemId: 'item-sync' as ItemId, cursor: 500 }])

      // Subsequent pull returns peer message at 450 and echoed push message at 500
      await manager.processPullResults([
        {
          success: true,
          itemId: 'item-sync' as ItemId,
          messages: [
            {
              cursor: 450,
              encryptedMessage: { iv: 'iv-peer', cipher: 'c-peer', version: 'legacy' },
            },
            {
              cursor: 500,
              encryptedMessage: { iv: 'iv-pushed', cipher: 'c-pushed', version: 'legacy' },
            },
          ],
          hasMore: false,
          nextCursor: 500,
        },
      ])

      // Peer message at 450 must be parsed, pushed message at 500 must be skipped (deduped)
      expect(onMessageParsedSpy).toHaveBeenCalledTimes(1)
      expect(manager.exportCursors()).toContainEqual(['item-sync', 500])
    })

    it('ignores failed push results with success: false', async () => {
      const onMessageParsedSpy = vi.fn()
      manager.onMessageParsed = onMessageParsedSpy

      manager.processPushResults([
        { itemId: 'item-fail' as ItemId, cursor: 100, success: false },
        { itemId: 'item-ok' as ItemId, cursor: 50, success: true },
      ])

      // Pull both messages
      await manager.processPullResults([
        {
          success: true,
          itemId: 'item-fail' as ItemId,
          messages: [
            {
              cursor: 100,
              encryptedMessage: { iv: 'iv-fail', cipher: 'c-fail', version: 'legacy' },
            },
          ],
          hasMore: false,
        },
        {
          success: true,
          itemId: 'item-ok' as ItemId,
          messages: [
            {
              cursor: 50,
              encryptedMessage: { iv: 'iv-ok', cipher: 'c-ok', version: 'legacy' },
            },
          ],
          hasMore: false,
        },
      ])

      // item-fail was NOT marked seen (success: false), so its message is parsed.
      // item-ok WAS marked seen (success: true), so its message is skipped.
      expect(onMessageParsedSpy).toHaveBeenCalledTimes(1)
    })
  })

  describe('persistCursors and shutdown', () => {
    beforeEach(async () => {
      await manager.setAccount('account-quota')
    })

    it('handles storage quota error during persistCursors', async () => {
      await manager.importCursors([['item-quota' as ItemId, 5]])

      const error = new DOMException('Quota Exceeded', 'QuotaExceededError')
      activeStore!.setItem.mockRejectedValueOnce(error)

      // Trigger immediate persist instead of debounced
      await expect(manager.persistCursors()).resolves.toBeUndefined()
      expect(mockReportQuotaExceeded).toHaveBeenCalled()
    })

    it('persists cursors on shutdown and cancels debounced timer', async () => {
      await manager.importCursors([['item-z' as ItemId, 500]])
      await manager.shutdown()

      expect(activeStore?.setItem).toHaveBeenCalledWith('cursorByItemId', expect.any(Array))
    })

    it('cancels debounced timer and skips persisting when clearLocalData is true', async () => {
      await manager.importCursors([['item-z' as ItemId, 500]])
      activeStore!.setItem.mockClear()

      await manager.shutdown({ clearLocalData: true })

      expect(activeStore?.setItem).not.toHaveBeenCalled()
    })

    it('is idempotent on multiple shutdown calls and does not wipe out data on second call', async () => {
      await manager.importCursors([['item-z' as ItemId, 500]])
      activeStore!.setItem.mockClear()

      await manager.shutdown()
      expect(activeStore?.setItem).toHaveBeenCalledTimes(1)
      expect(activeStore?.setItem).toHaveBeenCalledWith('cursorByItemId', [['item-z', 500]])

      activeStore!.setItem.mockClear()
      await manager.shutdown()
      expect(activeStore?.setItem).not.toHaveBeenCalled()
    })

    it('ignores pull and push results after shutdown', async () => {
      await manager.shutdown()
      activeStore!.setItem.mockClear()

      manager.processPushResults([{ itemId: 'item-new' as ItemId, cursor: 100 }])
      await manager.processPullResults([{ success: true, itemId: 'item-new' as ItemId, messages: [], hasMore: false }])

      expect(activeStore?.setItem).not.toHaveBeenCalled()
      expect(manager.exportCursors()).toEqual([])
    })
  })

  describe('importCursors', () => {
    it('stores imported cursors to cursorStore', async () => {
      await manager.setAccount('account-import')
      const imported: [ItemId, number][] = [['item-abc' as ItemId, 77]]

      await manager.importCursors(imported)
      expect(manager.exportCursors()).toEqual(imported)
      expect(activeStore?.setItem).toHaveBeenCalledWith('cursorByItemId', imported)
    })
  })

  describe('loadCursors and reloadCursors', () => {
    it('loads updated cursors from CursorStore when in-memory cursors are stale', async () => {
      await manager.setAccount('account-reload')

      // Initial in-memory state: item-1 at cursor 10
      await manager.importCursors([['item-1' as ItemId, 10]])
      expect(manager.getGlobalLatestCursor()).toBe(10)

      // Another tab (previous leader) advanced cursors in CursorStore
      activeStore?.getItem.mockResolvedValueOnce([
        ['item-1', 100],
        ['item-2', 250],
      ])

      // Promoted leader reloads cursors
      await manager.loadCursors()

      // Stored higher cursors must now be reflected in-memory
      expect(manager.exportCursors()).toEqual(
        expect.arrayContaining([
          ['item-1', 100],
          ['item-2', 250],
        ])
      )
      expect(manager.getGlobalLatestCursor()).toBe(250)
    })

    it('does not regress in-memory cursors if in-memory is higher than stored', async () => {
      await manager.setAccount('account-reload-monotonic')

      await manager.importCursors([['item-1' as ItemId, 50]])

      // CursorStore has a lower cursor (e.g. lagging read)
      activeStore?.getItem.mockResolvedValueOnce([
        ['item-1', 20],
      ])

      await manager.reloadCursors()

      // In-memory cursor must not regress
      expect(manager.exportCursors()).toEqual([['item-1', 50]])
      expect(manager.getGlobalLatestCursor()).toBe(50)
    })

    it('preserves pending status when reloading cursors', async () => {
      await manager.setAccount('account-reload-pending')

      manager.addPendingItem('item-pending' as ItemId)
      expect(manager.hasPendingPulls()).toBe(true)

      // CursorStore has cursor 42 for item-pending
      activeStore?.getItem.mockResolvedValueOnce([
        ['item-pending', 42],
      ])

      await manager.loadCursors()

      expect(manager.hasPendingPulls()).toBe(true)
      expect(manager.getCursors()).toEqual([{ itemId: 'item-pending', cursor: 42 }])
    })

    it('ignores reload if manager is shutdown or account is null', async () => {
      await manager.setAccount('account-reload-shutdown')
      await manager.shutdown()

      activeStore?.getItem.mockResolvedValueOnce([['item-1', 999]])
      await manager.loadCursors()

      expect(manager.exportCursors()).toEqual([])
    })
  })
})
