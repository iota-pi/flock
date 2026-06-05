import { interpretAsDocumentId } from '@automerge/automerge-repo/slim'
import localforage from 'localforage'

import { SyncPullQueueManager } from './SyncPullQueueManager'
import { ACCOUNT_INDEX_DOCUMENT_ID } from './automergeConstants'
import { toAutomergeUrlFromItemId } from './automergeRepoIds'
import type { PullSyncMessagesResponse } from 'src/api/vault/SyncWorkerClient'

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
vi.mock('../api/syncHealthCoordinator', () => ({
  reportDecryptionFailure: (...args: any[]) => mockReportDecryptionFailure(...args),
}))

const mockPublishRealtimeBusSyncPing = vi.fn()
vi.mock('./realtimeBus', () => ({
  publishRealtimeBusSyncPing: (...args: any[]) => mockPublishRealtimeBusSyncPing(...args),
}))

const mockReportQuotaExceeded = vi.fn()
vi.mock('../workers/quotaReporter', () => ({
  reportQuotaExceeded: (...args: any[]) => mockReportQuotaExceeded(...args),
}))


describe('SyncPullQueueManager', () => {
  let manager: SyncPullQueueManager

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    activeStore = null
    manager = new SyncPullQueueManager()

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
      manager.addPendingItem('item-1')
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

      await manager.setAccount('account-2')
      expect(manager.exportCursors()).toEqual(preLoadedCursors)
    })
  })

  describe('pending items management', () => {
    it('manages pending items correctly', () => {
      expect(manager.hasPendingPulls()).toBe(false)

      manager.addPendingItem('item-1')
      manager.addPendingItem('') // should be ignored

      expect(manager.hasPendingPulls()).toBe(true)

      manager.shutdown()
      expect(manager.hasPendingPulls()).toBe(false)
    })
  })

  describe('getAllCursors', () => {
    it('always includes ACCOUNT_INDEX_DOCUMENT_ID', () => {
      const cursors = manager.getAllCursors()
      expect(cursors).toHaveLength(1)
      expect(cursors[0]).toEqual({
        itemId: ACCOUNT_INDEX_DOCUMENT_ID,
        cursor: 0,
      })
    })

    it('only includes cursors for pending items', async () => {
      await manager.setAccount('account-1')

      // Let's add multiple cursors to internal state
      manager.processPushResults([
        { itemId: 'item-1', cursor: 10 },
        { itemId: 'item-2', cursor: 20 },
      ])

      // Since none are pending, only account index doc should be returned
      let cursors = manager.getAllCursors()
      expect(cursors).toHaveLength(1)

      // Add item-1 as pending
      manager.addPendingItem('item-1')
      cursors = manager.getAllCursors()

      expect(cursors).toHaveLength(2)
      expect(cursors).toContainEqual({ itemId: ACCOUNT_INDEX_DOCUMENT_ID, cursor: 0 })
      expect(cursors).toContainEqual({ itemId: 'item-1', cursor: 10 })
    })
  })

  describe('processPullResults', () => {
    beforeEach(async () => {
      await manager.setAccount('account-1')
    })

    it('parses single unbatched message', async () => {
      const onMessageParsedSpy = vi.fn()
      manager.onMessageParsed = onMessageParsedSpy

      const pullResults: PullSyncMessagesResponse[] = [
        {
          success: true,
          itemId: 'item-1',
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

      const expectedDocId = interpretAsDocumentId(await toAutomergeUrlFromItemId('item-1'))
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
          itemId: 'item-2',
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

      const expectedDocId = interpretAsDocumentId(await toAutomergeUrlFromItemId('item-2'))
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

    it('handles decryption failure by calling reportDecryptionFailure', async () => {
      mockDecryptBytes.mockRejectedValueOnce(new Error('Decryption failed'))

      const pullResults: PullSyncMessagesResponse[] = [
        {
          success: true,
          itemId: 'item-fail',
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

      expect(mockReportDecryptionFailure).toHaveBeenCalledWith({
        itemId: 'item-fail',
        error: expect.any(Error),
      })
      // Cursors should still update to highest/nextCursor even if message decryption fails
      expect(manager.exportCursors()).toContainEqual(['item-fail', 20])
    })

    it('re-queues pending items and clears them based on hasMore', async () => {
      // First batch hasMore: true
      await manager.processPullResults([
        {
          success: true,
          itemId: 'item-x',
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
          itemId: 'item-x',
          hasMore: false,
          nextCursor: 105,
          messages: [],
        },
      ])
      expect(manager.hasPendingPulls()).toBe(false)
    })
  })

  describe('processPushResults', () => {
    beforeEach(async () => {
      await manager.setAccount('account-1')
    })

    it('updates cursor only if higher and clears matching pending pull', async () => {
      manager.addPendingItem('item-y')

      // Push results with higher cursor
      manager.processPushResults([{ itemId: 'item-y', cursor: 50 }])

      expect(manager.exportCursors()).toContainEqual(['item-y', 50])
      expect(manager.hasPendingPulls()).toBe(false) // should delete item-y from pending

      // Push results with lower cursor (should be ignored)
      manager.processPushResults([{ itemId: 'item-y', cursor: 40 }])
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

      manager.processPushResults([{ itemId: 'item-quota', cursor: 5 }])

      // Trigger immediate persist instead of debounced
      await expect(manager.persistCursors()).resolves.toBeUndefined()
      expect(mockReportQuotaExceeded).toHaveBeenCalled()
    })

    it('persists cursors on shutdown and cancels debounced timer', async () => {
      manager.processPushResults([{ itemId: 'item-z', cursor: 500 }])
      await manager.shutdown()

      expect(activeStore?.setItem).toHaveBeenCalledWith('cursorByItemId', expect.any(Array))
    })
  })

  describe('importCursors', () => {
    it('stores imported cursors to cursorStore', async () => {
      await manager.setAccount('account-import')
      const imported: [string, number][] = [['item-abc', 77]]

      await manager.importCursors(imported)
      expect(manager.exportCursors()).toEqual(imported)
      expect(activeStore?.setItem).toHaveBeenCalledWith('cursorByItemId', imported)
    })
  })
})
