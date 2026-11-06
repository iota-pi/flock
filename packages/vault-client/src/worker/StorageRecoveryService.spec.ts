import { StorageRecoveryService } from './StorageRecoveryService'
import { ClientEventHub } from './SyncEventHub'
import type { ItemId } from '@vault/shared'
import * as storageManager from '../utils/storageManager'
import { SyncSessionState } from './SyncSessionState'

describe('StorageRecoveryService', () => {
  let clientEventHub: ClientEventHub
  let mockOutbox: any
  let mockDocStore: any
  let mockSnapshotManager: any
  let mockSnapshotTracker: any
  let mockLastModifiedStore: any
  let mockOrchestrator: any
  let session: SyncSessionState
  let service: StorageRecoveryService

  beforeEach(() => {
    clientEventHub = new ClientEventHub()
    mockOutbox = {
      markAll: vi.fn().mockResolvedValue(undefined),
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
    session = new SyncSessionState()
    mockOrchestrator = {
      flush: vi.fn(),
    }

    service = new StorageRecoveryService({
      session,
      clientEventHub,
      outbox: mockOutbox,
      docStore: mockDocStore,
      snapshotManager: mockSnapshotManager,
      lastModifiedStore: mockLastModifiedStore,
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

    it('emits quotaExceeded when the retry also hits the quota', async () => {
      const emitSpy = vi.spyOn(clientEventHub, 'emit')
      service.start()

      await expect(storageManager.runStorageOperation(async () => { throw quotaError() })).rejects.toThrow()

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
      expect(mockDocStore.saveDocToStorage).toHaveBeenCalledWith('item-1')
      expect(mockDocStore.saveDocToStorage).toHaveBeenCalledWith('item-2')

      expect(mockOutbox.markAll).toHaveBeenCalledWith(['item-1', 'item-2'])

      expect(mockSnapshotTracker.saveLastModified).toHaveBeenCalled()
      expect(mockSnapshotManager.flushPendingSnapshots).toHaveBeenCalled()
      expect(mockOrchestrator.flush).toHaveBeenCalled()

      expect(resetSpy).toHaveBeenCalledTimes(1)
      expect(emitSpy).toHaveBeenCalledWith({ type: 'quotaResolved' })
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
