import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StorageRecoveryService, QuotaExceededRetryError } from './StorageRecoveryService'
import { ClientEventHub } from './SyncEventHub'
import type { ItemId } from 'src/shared/schemas/items'
import { toDocumentIdFromItemId } from './utils/automerge'
import * as storageManager from '../../utils/storageManager'

describe('StorageRecoveryService', () => {
  let clientEventHub: ClientEventHub
  let mockWal: any
  let mockDocStore: any
  let mockSnapshotManager: any
  let mockLastModifiedStore: any
  let mockBroker: any
  let mockAdapter: any
  let mockOrchestrator: any
  let onQuotaStatusChange: any
  let service: StorageRecoveryService

  beforeEach(() => {
    clientEventHub = new ClientEventHub()
    mockWal = {
      handleQuotaExceeded: vi.fn().mockResolvedValue(5),
    }
    mockDocStore = {
      saveDocToStorage: vi.fn().mockResolvedValue(true),
    }
    mockSnapshotManager = {
      getDirtyItemIds: vi.fn().mockReturnValue(['item-1' as ItemId, 'item-2' as ItemId]),
      persistLastModified: vi.fn().mockResolvedValue(undefined),
      flushPendingSnapshots: vi.fn().mockResolvedValue({ persisted: 1, total: 1 }),
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
    mockOrchestrator = {
      online: true,
      flush: vi.fn(),
    }
    onQuotaStatusChange = vi.fn()

    service = new StorageRecoveryService({
      accountId: 'test-account',
      clientEventHub,
      wal: mockWal,
      docStore: mockDocStore,
      snapshotManager: mockSnapshotManager,
      lastModifiedStore: mockLastModifiedStore,
      broker: mockBroker,
      adapter: mockAdapter,
      orchestrator: mockOrchestrator,
      onQuotaStatusChange,
    })
  })

  afterEach(() => {
    service.stop()
    storageManager.resetQuotaExceededStatus()
    storageManager.clearQuotaRecoveryHandlerForTesting()
    vi.restoreAllMocks()
  })

  describe('Lifecycle (start / stop)', () => {
    it('registers quota recovery handler and reporter on start, and cleans up on stop', () => {
      const registerRecoverySpy = vi.spyOn(storageManager, 'registerQuotaRecoveryHandler')
      const registerReporterSpy = vi.spyOn(storageManager, 'registerQuotaReporter')

      service.start()

      expect(registerRecoverySpy).toHaveBeenCalledTimes(1)
      expect(registerReporterSpy).toHaveBeenCalledTimes(1)

      service.stop()
      // Calling stop again is idempotent
      service.stop()
    })
  })

  describe('Emergency Compaction & Detection', () => {
    it('calls wal.handleQuotaExceeded in handleEmergencyCompaction', async () => {
      const reduced = await service.handleEmergencyCompaction()
      expect(reduced).toBe(5)
      expect(mockWal.handleQuotaExceeded).toHaveBeenCalledTimes(1)
    })

    it('updates status and emits quotaExceeded event in handleQuotaExceeded', async () => {
      const emitSpy = vi.spyOn(clientEventHub, 'emit')

      await service.handleQuotaExceeded('Storage limit reached')

      expect(service.getQuotaExceeded()).toBe(true)
      expect(onQuotaStatusChange).toHaveBeenCalledWith(true)
      expect(mockWal.handleQuotaExceeded).toHaveBeenCalledTimes(1)
      expect(emitSpy).toHaveBeenCalledWith({
        type: 'quotaExceeded',
        message: 'Storage limit reached',
      })
    })

    it('provides default message when handleQuotaExceeded is called with non-string error', async () => {
      const emitSpy = vi.spyOn(clientEventHub, 'emit')
      const quotaError = new DOMException('Quota exceeded', 'QuotaExceededError')

      await service.handleQuotaExceeded(quotaError)

      expect(service.getQuotaExceeded()).toBe(true)
      expect(emitSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'quotaExceeded',
          message: expect.stringContaining('Storage quota exceeded'),
        })
      )
    })

    it('still sets quotaExceeded and emits event if emergency compaction fails', async () => {
      mockWal.handleQuotaExceeded.mockRejectedValueOnce(new Error('Compaction failed'))
      const emitSpy = vi.spyOn(clientEventHub, 'emit')

      await service.handleQuotaExceeded('Quota error')

      expect(service.getQuotaExceeded()).toBe(true)
      expect(onQuotaStatusChange).toHaveBeenCalledWith(true)
      expect(emitSpy).toHaveBeenCalledWith({
        type: 'quotaExceeded',
        message: 'Quota error',
      })
    })
  })

  describe('Probing, Circuits, and Resolution', () => {
    it('probeStorageAvailability passes when testStorageAvailable succeeds', async () => {
      await expect(service.probeStorageAvailability()).resolves.toBeUndefined()
      expect(mockLastModifiedStore.testStorageAvailable).toHaveBeenCalledTimes(1)
    })

    it('probeStorageAvailability throws QuotaExceededRetryError when testStorageAvailable throws QuotaExceededError', async () => {
      const quotaErr = new DOMException('Quota exceeded', 'QuotaExceededError')
      mockLastModifiedStore.testStorageAvailable.mockRejectedValueOnce(quotaErr)

      await expect(service.probeStorageAvailability()).rejects.toThrow(QuotaExceededRetryError)
    })

    it('probeStorageAvailability rethrows unexpected non-quota errors', async () => {
      mockLastModifiedStore.testStorageAvailable.mockRejectedValueOnce(new Error('Disk read error'))

      await expect(service.probeStorageAvailability()).rejects.toThrow('Disk read error')
    })

    it('resetStorageCircuits calls broker.unblockAllItems and adapter.resetReNegotiationCircuit', () => {
      service.resetStorageCircuits()

      expect(mockBroker.unblockAllItems).toHaveBeenCalledTimes(1)
      expect(mockAdapter.resetReNegotiationCircuit).toHaveBeenCalledTimes(1)
    })

    it('resolveQuotaStatus resets status, calls onQuotaStatusChange(false), and emits quotaResolved', () => {
      const emitSpy = vi.spyOn(clientEventHub, 'emit')
      service.resolveQuotaStatus()

      expect(service.getQuotaExceeded()).toBe(false)
      expect(onQuotaStatusChange).toHaveBeenCalledWith(false)
      expect(emitSpy).toHaveBeenCalledWith({ type: 'quotaResolved' })
    })
  })

  describe('retrySave', () => {
    it('executes full sequence on success', async () => {
      const emitSpy = vi.spyOn(clientEventHub, 'emit')

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

      expect(mockSnapshotManager.persistLastModified).toHaveBeenCalled()
      expect(mockSnapshotManager.flushPendingSnapshots).toHaveBeenCalled()
      expect(mockOrchestrator.flush).toHaveBeenCalled()

      expect(emitSpy).toHaveBeenCalledWith({ type: 'quotaResolved' })
      expect(service.getQuotaExceeded()).toBe(false)
      expect(onQuotaStatusChange).toHaveBeenCalledWith(false)
    })

    it('includes blocked items from broker in dirtyIds during retrySave', async () => {
      mockSnapshotManager.getDirtyItemIds.mockReturnValue(['item-1' as ItemId])
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
      mockSnapshotManager.persistLastModified.mockRejectedValueOnce(quotaErr)

      const result = await service.retrySave()

      expect(result.success).toBe(false)
      expect(result.error).toContain('still exceeded while saving timestamps')
    })

    it('handles unexpected errors gracefully and returns error message', async () => {
      mockSnapshotManager.persistLastModified.mockRejectedValueOnce(new Error('Database corrupted'))

      const result = await service.retrySave()

      expect(result.success).toBe(false)
      expect(result.error).toBe('Database corrupted')
    })

    it('does not flush snapshots if orchestrator is offline', async () => {
      mockOrchestrator.online = false

      const result = await service.retrySave()

      expect(result.success).toBe(true)
      expect(mockSnapshotManager.flushPendingSnapshots).not.toHaveBeenCalled()
      expect(mockOrchestrator.flush).not.toHaveBeenCalled()
    })
  })
})
