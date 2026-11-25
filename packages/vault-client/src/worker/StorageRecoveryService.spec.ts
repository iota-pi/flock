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
  let mockItemSyncState: any
  let mockMetadataStore: any
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
    mockItemSyncState = {
      save: vi.fn().mockResolvedValue(undefined),
    }
    mockSnapshotManager = {
      flushPendingSnapshots: vi.fn().mockResolvedValue({ persisted: 1, total: 1 }),
      schedule: {
        getDirtyItemIds: vi.fn().mockReturnValue(['item-1' as ItemId, 'item-2' as ItemId]),
      },
      state: mockItemSyncState,
    }
    mockMetadataStore = {
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
      metadataStore: mockMetadataStore,
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
      expect(mockMetadataStore.testStorageAvailable).toHaveBeenCalled()
      expect(mockDocStore.saveDocToStorage).toHaveBeenCalledWith('item-1')
      expect(mockDocStore.saveDocToStorage).toHaveBeenCalledWith('item-2')

      expect(mockOutbox.markAll).toHaveBeenCalledWith(['item-1', 'item-2'])

      expect(mockItemSyncState.save).toHaveBeenCalled()
      expect(mockSnapshotManager.flushPendingSnapshots).toHaveBeenCalled()
      expect(mockOrchestrator.flush).toHaveBeenCalled()

      expect(resetSpy).toHaveBeenCalledTimes(1)
      expect(emitSpy).toHaveBeenCalledWith({ type: 'quotaResolved' })
    })

    it("saves the docs of this tab's edits, which aren't queued for a snapshot, until a retry succeeds", async () => {
      mockSnapshotManager.schedule.getDirtyItemIds.mockReturnValue([])
      service.recordEdit('edited' as ItemId)
      mockMetadataStore.testStorageAvailable.mockRejectedValueOnce(new DOMException('Quota exceeded', 'QuotaExceededError'))

      expect((await service.retrySave()).success).toBe(false)
      expect(await service.retrySave()).toEqual({ success: true })
      expect(mockDocStore.saveDocToStorage).toHaveBeenCalledWith('edited')
      expect(mockOutbox.markAll).toHaveBeenCalledWith(['edited'])

      mockOutbox.markAll.mockClear()
      await service.retrySave()
      expect(mockOutbox.markAll).toHaveBeenCalledWith([])
    })

    it('returns failure when storage probe fails with QuotaExceededError', async () => {
      const quotaErr = new DOMException('Quota exceeded', 'QuotaExceededError')
      mockMetadataStore.testStorageAvailable.mockRejectedValueOnce(quotaErr)

      const result = await service.retrySave()

      expect(result.success).toBe(false)
      expect(result.error).toContain('still exceeded')
      expect(mockDocStore.saveDocToStorage).not.toHaveBeenCalled()
    })

    it('rethrows a probe failure that is not a quota error', async () => {
      mockMetadataStore.testStorageAvailable.mockRejectedValueOnce(new Error('Disk read error'))

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

    it('returns failure when saving sync records throws QuotaExceededError', async () => {
      const quotaErr = new DOMException('Quota exceeded', 'QuotaExceededError')
      mockItemSyncState.save.mockRejectedValueOnce(quotaErr)

      const result = await service.retrySave()

      expect(result.success).toBe(false)
      expect(result.error).toContain('still exceeded while saving sync records')
    })

    it('handles unexpected errors gracefully and returns error message', async () => {
      mockItemSyncState.save.mockRejectedValueOnce(new Error('Database corrupted'))

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
