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
  let becomeLeader: Mock<() => Promise<void>>
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
    becomeLeader = vi.fn().mockResolvedValue(undefined)
    service = new ItemRecoveryService({
      repoManager: mockRepoManager,
      docStore: mockDocStore,
      recoveryManager: mockRecoveryManager,
      snapshotSchedule: mockSnapshotSchedule,
      snapshotPusher: mockSnapshotPusher,
      syncManifest,
      itemOperations: mockItemOperations,
      becomeLeader,
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

    it('takes over syncing before it drops the local copy', async () => {
      await service.replaceFromServer('item-1' as ItemId)

      expect(becomeLeader.mock.invocationCallOrder[0])
        .toBeLessThan(mockRepoManager.repo.delete.mock.invocationCallOrder[0])
    })

    it('keeps the local copy when this tab cannot take over syncing', async () => {
      becomeLeader.mockRejectedValue(new Error('This tab could not take over syncing'))

      await expect(service.replaceFromServer('item-1' as ItemId)).rejects.toThrow(/could not take over/)

      expect(mockRepoManager.repo.delete).not.toHaveBeenCalled()
      expect(mockRepoManager.storage.removeRange).not.toHaveBeenCalled()
      expect(syncManifest).not.toHaveBeenCalled()
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
    it('takes over syncing, then releases a quarantined item and pushes its snapshot again', async () => {
      await service.retryRecoveryItem('item-1' as ItemId)

      expect(becomeLeader.mock.invocationCallOrder[0])
        .toBeLessThan(mockRecoveryManager.unquarantine.mock.invocationCallOrder[0])
      expect(mockRecoveryManager.unquarantine).toHaveBeenCalledWith('item-1')
      expect(mockSnapshotPusher.clearOversized).toHaveBeenCalledWith('item-1')
      expect(mockSnapshotSchedule.markItemDirty).toHaveBeenCalledWith('item-1')
      expect(mockSnapshotPusher.flushPendingSnapshots).toHaveBeenCalled()
    })

    it('keeps the item quarantined when this tab cannot take over syncing', async () => {
      becomeLeader.mockRejectedValue(new Error('This tab could not take over syncing'))

      await expect(service.retryRecoveryItem('item-1' as ItemId)).rejects.toThrow(/could not take over/)

      expect(mockRecoveryManager.unquarantine).not.toHaveBeenCalled()
      expect(mockSnapshotSchedule.markItemDirty).not.toHaveBeenCalled()
    })
  })

  it('recreates an oversized item and pushes the old one as a tombstone', async () => {
    const newItemId = await service.recreateOversizedItem('item-old' as ItemId)

    expect(newItemId).toBe('item-new')
    expect(mockItemOperations.recreateOversizedItem).toHaveBeenCalledWith('item-old')
    expect(mockSnapshotPusher.clearOversized).toHaveBeenCalledWith('item-old')
    expect(mockSnapshotSchedule.markItemDirty).not.toHaveBeenCalled()
    expect(mockSnapshotPusher.flushPendingSnapshots).toHaveBeenCalled()
  })
})
