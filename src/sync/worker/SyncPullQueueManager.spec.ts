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

const mockReportDecryptionFailure = vi.fn()
vi.mock('../../api/syncHealthCoordinator', () => ({
  reportDecryptionFailure: (...args: any[]) => mockReportDecryptionFailure(...args),
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
      let cursors = manager.getAllCursors()
      expect(cursors).toHaveLength(0)

      // Add pending items
      manager.addPendingItem('item-1' as ItemId)
      manager.addPendingItem('item-2' as ItemId)
      cursors = manager.getAllCursors()

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

    it('handles decryption failure by calling reportDecryptionFailure without advancing cursor or removing from pending pulls', async () => {
      mockDecryptBytes.mockRejectedValueOnce(new Error('Decryption failed'))

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

      await manager.processPullResults(pullResults)

      expect(mockReportDecryptionFailure).toHaveBeenCalledWith(
        'account-1',
        {
          itemId: 'item-fail',
          error: expect.any(Error),
        }
      )
      // Cursors should NOT advance on decryption failure and item should stay pending
      expect(manager.exportCursors()).toEqual([['item-fail', 0]])
      expect(manager.hasPendingPulls()).toBe(true)
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

    it('handles message processing failure in a batch without dropping remaining messages and without advancing cursor', async () => {
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

    it('handles message processing error for non-batched message without advancing cursor', async () => {
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

    it('stops processing messages and preserves cursor before failed message when a parse failure occurs mid-batch', async () => {
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
