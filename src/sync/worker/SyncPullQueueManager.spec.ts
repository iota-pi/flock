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
      manager.processPushResults([
        { itemId: 'item-1' as ItemId, cursor: 10 },
        { itemId: 'item-2' as ItemId, cursor: 20 },
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

    it('handles message processing failure in a batch without dropping remaining messages and preserves item for retry', async () => {
      const onMessageParsedSpy = vi.fn().mockImplementation((itemId, docId, msg) => {
        if (msg[0] === 10) {
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

      mockDecryptBytes.mockResolvedValueOnce(combined)

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

      await manager.processPullResults(pullResults)

      const expectedDocId = interpretAsDocumentId(
        toAutomergeUrlFromItemId('item-batch-error' as ItemId)
      )
      expect(onMessageParsedSpy).toHaveBeenCalledTimes(2)
      expect(onMessageParsedSpy).toHaveBeenNthCalledWith(
        1,
        'item-batch-error',
        expectedDocId,
        msg1,
      )
      expect(onMessageParsedSpy).toHaveBeenNthCalledWith(
        2,
        'item-batch-error',
        expectedDocId,
        msg2,
      )

      expect(manager.exportCursors()).toEqual([['item-batch-error', 0]])
      expect(manager.hasPendingPulls()).toBe(true)
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
  })

  describe('processPushResults', () => {
    beforeEach(async () => {
      await manager.setAccount('account-1')
    })

    it('updates cursor only if higher and clears matching pending pull', async () => {
      manager.addPendingItem('item-y' as ItemId)

      // Push results with higher cursor
      manager.processPushResults([{ itemId: 'item-y' as ItemId, cursor: 50 }])

      expect(manager.exportCursors()).toContainEqual(['item-y', 50])
      expect(manager.hasPendingPulls()).toBe(false) // should delete item-y from pending

      // Push results with lower cursor (should be ignored)
      manager.processPushResults([{ itemId: 'item-y' as ItemId, cursor: 40 }])
      expect(manager.exportCursors()).toContainEqual(['item-y', 50])
    })
  })

  describe('persistCursors and shutdown', () => {
    beforeEach(async () => {
      await manager.setAccount('account-quota')
    })

    it('handles storage quota error during persistCursors', async () => {
      const error = new DOMException('Quota Exceeded', 'QuotaExceededError')
      activeStore!.setItem.mockRejectedValueOnce(error)

      manager.processPushResults([{ itemId: 'item-quota' as ItemId, cursor: 5 }])

      // Trigger immediate persist instead of debounced
      await expect(manager.persistCursors()).resolves.toBeUndefined()
      expect(mockReportQuotaExceeded).toHaveBeenCalled()
    })

    it('persists cursors on shutdown and cancels debounced timer', async () => {
      manager.processPushResults([{ itemId: 'item-z' as ItemId, cursor: 500 }])
      await manager.shutdown()

      expect(activeStore?.setItem).toHaveBeenCalledWith('cursorByItemId', expect.any(Array))
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
})
