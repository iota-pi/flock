import { StorageRecoveryService } from './StorageRecoveryService'
import { ClientEventHub } from './SyncEventHub'
import type { ItemId } from '@vault/shared'
import { toDocumentIdFromItemId } from './utils/automerge'
import * as storageManager from '../utils/storageManager'
import { SyncSessionState } from './SyncSessionState'

describe('StorageRecoveryService', () => {
  let clientEventHub: ClientEventHub
  let mockWal: any
  let mockDocStore: any
  let mockSnapshotManager: any
  let mockSnapshotTracker: any
  let mockLastModifiedStore: any
  let mockBroker: any
  let mockAdapter: any
  let mockOrchestrator: any
  let session: SyncSessionState
  let service: StorageRecoveryService

  beforeEach(() => {
    clientEventHub = new ClientEventHub()
    mockWal = {
      handleQuotaExceeded: vi.fn().mockResolvedValue(5),
    }
    mockDocStore = {
      saveDocToStorage: vi.fn().mockResolvedValue(true),
    }
    mockSnapshotTracker = {
      getDirtyItemIds: vi.fn().mockReturnValue(['item-1' as ItemId, 'item-2' as ItemId]),
      saveLastModified: vi.fn().mockResolvedValue(undefined),
    }
    mockSnapshotManager = {
      flushPendingSnapshots: vi.fn().mockResolvedValue({ persisted: 1, total: 1 }),
      tracker: mockSnapshotTracker,
    }
    mockLastModifiedStore = {
      testStorageAvailable: vi.fn().mockResolvedValue(undefined),
    }
    mockBroker = {
      unblockAllItems: vi.fn(),
      getBlockedItemIds: vi.fn().mockReturnValue([]),
    }
    mockAdapter = {
      resetReNegotiationCircuit: vi.fn(),
      triggerReNegotiation: vi.fn(),
    }
    session = new SyncSessionState()
    mockOrchestrator = {
      flush: vi.fn(),
    }

    service = new StorageRecoveryService({
      session,
      clientEventHub,
      wal: mockWal,
      docStore: mockDocStore,
      snapshotManager: mockSnapshotManager,
      lastModifiedStore: mockLastModifiedStore,
      broker: mockBroker,
      adapter: mockAdapter,
      orchestrator: mockOrchestrator,
    })
  })

  afterEach(() => {
    service.stop()
    storageManager.resetQuotaExceededStatus()
    storageManager.clearQuotaRecoveryHandlerForTesting()
    vi.restoreAllMocks()
  })

  describe('Quota handling', () => {
    const quotaError = () => new DOMException('Quota exceeded', 'QuotaExceededError')

    it('prunes the WAL once and retries a write that hits the quota, without reporting it', async () => {
      const emitSpy = vi.spyOn(clientEventHub, 'emit')
      service.start()

      let attempts = 0
      const result = await storageManager.runStorageOperation(async () => {
        attempts += 1
        if (attempts === 1) throw quotaError()
        return 'saved'
      })

      expect(result).toBe('saved')
      expect(mockWal.handleQuotaExceeded).toHaveBeenCalledTimes(1)
      expect(emitSpy).not.toHaveBeenCalled()
    })

    it('emits quotaExceeded without pruning again when the retry also hits the quota', async () => {
      const emitSpy = vi.spyOn(clientEventHub, 'emit')
      service.start()

      await expect(storageManager.runStorageOperation(async () => { throw quotaError() })).rejects.toThrow()

      expect(mockWal.handleQuotaExceeded).toHaveBeenCalledTimes(1)
      expect(emitSpy).toHaveBeenCalledWith({
        type: 'quotaExceeded',
        message: expect.stringContaining('Storage quota exceeded'),
      })
    })

    it('unregisters its handlers on stop', async () => {
      const emitSpy = vi.spyOn(clientEventHub, 'emit')
      service.start()
      service.stop()

      await expect(storageManager.runStorageOperation(async () => { throw quotaError() })).rejects.toThrow()

      expect(mockWal.handleQuotaExceeded).not.toHaveBeenCalled()
      expect(emitSpy).not.toHaveBeenCalled()
    })
  })

  describe('retrySave', () => {
    it('executes full sequence on success', async () => {
      const emitSpy = vi.spyOn(clientEventHub, 'emit')
      const resetSpy = vi.spyOn(storageManager, 'resetQuotaExceededStatus')

      const result = await service.retrySave()

      expect(result.success).toBe(true)
      expect(mockLastModifiedStore.testStorageAvailable).toHaveBeenCalled()
      expect(mockBroker.unblockAllItems).toHaveBeenCalled()
      expect(mockAdapter.resetReNegotiationCircuit).toHaveBeenCalled()

      expect(mockDocStore.saveDocToStorage).toHaveBeenCalledWith('item-1')
      expect(mockDocStore.saveDocToStorage).toHaveBeenCalledWith('item-2')

      const doc1 = toDocumentIdFromItemId('item-1' as ItemId)
      const doc2 = toDocumentIdFromItemId('item-2' as ItemId)
      expect(mockAdapter.triggerReNegotiation).toHaveBeenCalledWith(doc1)
      expect(mockAdapter.triggerReNegotiation).toHaveBeenCalledWith(doc2)

      expect(mockSnapshotTracker.saveLastModified).toHaveBeenCalled()
      expect(mockSnapshotManager.flushPendingSnapshots).toHaveBeenCalled()
      expect(mockOrchestrator.flush).toHaveBeenCalled()

      expect(resetSpy).toHaveBeenCalledTimes(1)
      expect(emitSpy).toHaveBeenCalledWith({ type: 'quotaResolved' })
    })

    it('includes blocked items from broker in dirtyIds during retrySave', async () => {
      mockSnapshotTracker.getDirtyItemIds.mockReturnValue(['item-1' as ItemId])
      mockBroker.getBlockedItemIds.mockReturnValue(['item-blocked' as ItemId])

      const result = await service.retrySave()

      expect(result.success).toBe(true)
      expect(mockDocStore.saveDocToStorage).toHaveBeenCalledWith('item-1')
      expect(mockDocStore.saveDocToStorage).toHaveBeenCalledWith('item-blocked')

      const doc1 = toDocumentIdFromItemId('item-1' as ItemId)
      const docBlocked = toDocumentIdFromItemId('item-blocked' as ItemId)
      expect(mockAdapter.triggerReNegotiation).toHaveBeenCalledWith(doc1)
      expect(mockAdapter.triggerReNegotiation).toHaveBeenCalledWith(docBlocked)
    })

    it('returns failure when storage probe fails with QuotaExceededError', async () => {
      const quotaErr = new DOMException('Quota exceeded', 'QuotaExceededError')
      mockLastModifiedStore.testStorageAvailable.mockRejectedValueOnce(quotaErr)

      const result = await service.retrySave()

      expect(result.success).toBe(false)
      expect(result.error).toContain('still exceeded')
      expect(mockDocStore.saveDocToStorage).not.toHaveBeenCalled()
    })

    it('rethrows a probe failure that is not a quota error', async () => {
      mockLastModifiedStore.testStorageAvailable.mockRejectedValueOnce(new Error('Disk read error'))

      const result = await service.retrySave()

      expect(result).toEqual({ success: false, error: 'Disk read error' })
      expect(mockDocStore.saveDocToStorage).not.toHaveBeenCalled()
    })

    it('returns failure when saving documents throws QuotaExceededError', async () => {
      const quotaErr = new DOMException('Quota exceeded', 'QuotaExceededError')
      mockDocStore.saveDocToStorage.mockRejectedValueOnce(quotaErr)

      const result = await service.retrySave()

      expect(result.success).toBe(false)
      expect(result.error).toContain('still exceeded while saving documents')
    })

    it('continues saving other documents if a non-quota error occurs on one document', async () => {
      mockDocStore.saveDocToStorage.mockRejectedValueOnce(new Error('Doc parse failure'))

      const result = await service.retrySave()

      expect(result.success).toBe(true)
      expect(mockDocStore.saveDocToStorage).toHaveBeenCalledWith('item-1')
      expect(mockDocStore.saveDocToStorage).toHaveBeenCalledWith('item-2')
    })

    it('returns failure when persisting timestamps throws QuotaExceededError', async () => {
      const quotaErr = new DOMException('Quota exceeded', 'QuotaExceededError')
      mockSnapshotTracker.saveLastModified.mockRejectedValueOnce(quotaErr)

      const result = await service.retrySave()

      expect(result.success).toBe(false)
      expect(result.error).toContain('still exceeded while saving timestamps')
    })

    it('handles unexpected errors gracefully and returns error message', async () => {
      mockSnapshotTracker.saveLastModified.mockRejectedValueOnce(new Error('Database corrupted'))

      const result = await service.retrySave()

      expect(result.success).toBe(false)
      expect(result.error).toBe('Database corrupted')
    })

    it('does not flush snapshots if orchestrator is offline', async () => {
      session.setOnline(false)

      const result = await service.retrySave()

      expect(result.success).toBe(true)
      expect(mockSnapshotManager.flushPendingSnapshots).not.toHaveBeenCalled()
      expect(mockOrchestrator.flush).not.toHaveBeenCalled()
    })
  })
})
