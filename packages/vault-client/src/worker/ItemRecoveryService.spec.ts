import type { Mock } from 'vitest'
import type { DocumentId } from '@automerge/automerge-repo/slim'
import type { ItemId } from '@vault/shared'
import { ItemRecoveryService } from './ItemRecoveryService'
import { toDocumentIdFromItemId } from './utils/automerge'

describe('ItemRecoveryService', () => {
  let mockRepoManager: any
  let mockDocStore: any
  let mockRecoveryManager: any
  let mockSnapshotSchedule: any
  let mockSnapshotPusher: any
  let syncManifest: any
  let mockItemOperations: any
  let onLocalCopyDiscarded: Mock<(documentId: DocumentId) => void>
  let service: ItemRecoveryService

  beforeEach(() => {
    mockRepoManager = {
      repo: { delete: vi.fn() },
      storage: { removeRange: vi.fn().mockResolvedValue(undefined) },
    }
    mockDocStore = {
      hasDataInStorage: vi.fn().mockResolvedValue(true),
    }
    mockRecoveryManager = {
      unquarantine: vi.fn().mockResolvedValue(undefined),
    }
    mockSnapshotSchedule = {
      markItemDirty: vi.fn(),
    }
    mockSnapshotPusher = {
      flushPendingSnapshots: vi.fn().mockResolvedValue({ persisted: 0, total: 0 }),
      clearOversized: vi.fn(),
    }
    syncManifest = vi.fn().mockResolvedValue({ added: [], success: true, fetchedManifest: true })
    mockItemOperations = {
      recreateOversizedItem: vi.fn().mockResolvedValue('item-new'),
    }
    onLocalCopyDiscarded = vi.fn()
    service = new ItemRecoveryService({
      repoManager: mockRepoManager,
      docStore: mockDocStore,
      recoveryManager: mockRecoveryManager,
      snapshotSchedule: mockSnapshotSchedule,
      snapshotPusher: mockSnapshotPusher,
      syncManifest,
      itemOperations: mockItemOperations,
      onLocalCopyDiscarded,
    })
  })

  describe('replaceFromServer', () => {
    it('replaces an unreadable document with the server\'s copy', async () => {
      const itemId = 'item-unreadable' as ItemId
      const documentId = toDocumentIdFromItemId(itemId)

      await service.replaceFromServer(itemId)

      expect(mockRepoManager.repo.delete).toHaveBeenCalledWith(documentId)
      expect(mockRepoManager.storage.removeRange).toHaveBeenCalledWith([documentId])
      expect(onLocalCopyDiscarded).toHaveBeenCalledWith(documentId)
      expect(syncManifest).toHaveBeenCalledWith('force')
      expect(mockRecoveryManager.unquarantine).toHaveBeenCalledWith(itemId)
    })

    it('keeps the item quarantined when the server has no copy to replace it with', async () => {
      mockDocStore.hasDataInStorage.mockResolvedValueOnce(false)

      await expect(service.replaceFromServer('item-gone' as ItemId)).rejects.toThrow(/could not be downloaded/)

      expect(mockRecoveryManager.unquarantine).not.toHaveBeenCalled()
    })

    it('keeps the item quarantined when the sync fails', async () => {
      syncManifest.mockResolvedValueOnce({ added: [], success: false, fetchedManifest: false })

      await expect(service.replaceFromServer('item-1' as ItemId)).rejects.toThrow(/could not be downloaded/)

      expect(mockRecoveryManager.unquarantine).not.toHaveBeenCalled()
    })
  })

  describe('retryRecoveryItem', () => {
    it('releases a quarantined item and pushes its snapshot again', async () => {
      await service.retryRecoveryItem('item-1' as ItemId)

      expect(mockRecoveryManager.unquarantine).toHaveBeenCalledWith('item-1')
      expect(mockSnapshotPusher.clearOversized).toHaveBeenCalledWith('item-1')
      expect(mockSnapshotSchedule.markItemDirty).toHaveBeenCalledWith('item-1')
      expect(mockSnapshotPusher.flushPendingSnapshots).toHaveBeenCalled()
    })
  })
})
