import { ReencryptionManager } from './ReencryptionManager'

const mockPutSnapshotsWithToken = vi.fn()
const mockGetActiveSessionToken = vi.fn()
const mockListAutomergeItemIds = vi.fn()

vi.mock('../../api/vault/SyncWorkerClient', () => ({
  putSnapshotsWithToken: (...args: any[]) => mockPutSnapshotsWithToken(...args),
}))

vi.mock('../shared/workerAuthStore', () => ({
  getActiveSessionToken: () => mockGetActiveSessionToken(),
}))

vi.mock('../../api/vault', () => ({
  encryptBytes: vi.fn().mockResolvedValue({
    iv: 'mock-iv',
    cipher: 'mock-cipher',
    kver: '1',
  }),
  initWorkerVault: vi.fn(),
}))

vi.mock('@automerge/automerge/slim', () => ({
  save: vi.fn().mockReturnValue(new Uint8Array([1, 2, 3])),
}))

vi.mock('./docStore/AutomergeIndexManager', () => ({
  AutomergeIndexManager: vi.fn().mockImplementation(() => ({
    listAutomergeItemIds: () => mockListAutomergeItemIds(),
  })),
}))

vi.mock('./docStore', () => ({
  normalizeItemSnapshot: vi.fn().mockReturnValue({
    type: 'note',
    deleted: false,
  }),
}))

vi.mock('./utils/automerge', () => ({
  toAutomergeUrlFromItemId: vi.fn().mockImplementation((id: string) => `automerge:${id}`),
}))

describe('ReencryptionManager', () => {
  let manager: ReencryptionManager
  let mockRepo: any
  let mockHandle: any
  let context: {
    accountId: string | null
    repo: any
    indexManager: any
  }

  beforeEach(() => {
    vi.clearAllMocks()

    mockHandle = {
      isReady: vi.fn().mockReturnValue(true),
      doc: vi.fn().mockReturnValue({ id: 'item-1', type: 'note' }),
    }

    mockRepo = {
      find: vi.fn().mockResolvedValue(mockHandle),
    }

    const mockIndexManager = {
      listAutomergeItemIds: () => mockListAutomergeItemIds(),
    } as any

    context = {
      accountId: 'test-account',
      repo: mockRepo,
      indexManager: mockIndexManager,
    }

    manager = new ReencryptionManager(context as any)
  })

  it('throws an error if accountId or repo is missing', async () => {
    context.accountId = null
    await expect(manager.reencryptAllItems()).rejects.toThrow('SyncWorker not initialized')

    context.accountId = 'test-account'
    context.repo = null
    await expect(manager.reencryptAllItems()).rejects.toThrow('SyncWorker not initialized')
  })

  it('throws an error if authToken is missing', async () => {
    mockGetActiveSessionToken.mockResolvedValue(null)
    await expect(manager.reencryptAllItems()).rejects.toThrow('No active session token available')
  })

  it('handles empty item list', async () => {
    mockGetActiveSessionToken.mockResolvedValue('mock-token')
    mockListAutomergeItemIds.mockResolvedValue([])

    const onProgress = vi.fn()
    await manager.reencryptAllItems(onProgress)

    expect(onProgress).toHaveBeenCalledWith(0, 0)
    expect(mockPutSnapshotsWithToken).not.toHaveBeenCalled()
  })

  it('successfully processes and uploads items in batches', async () => {
    mockGetActiveSessionToken.mockResolvedValue('mock-token')
    mockListAutomergeItemIds.mockResolvedValue(['item-1', 'item-2'])
    mockPutSnapshotsWithToken.mockResolvedValue({ success: true })

    const onProgress = vi.fn()
    await manager.reencryptAllItems(onProgress)

    expect(mockPutSnapshotsWithToken).toHaveBeenCalledTimes(1)
    expect(onProgress).toHaveBeenCalledWith(2, 2)
  })

  it('throws error if server upload fails', async () => {
    mockGetActiveSessionToken.mockResolvedValue('mock-token')
    mockListAutomergeItemIds.mockResolvedValue(['item-1'])
    mockPutSnapshotsWithToken.mockResolvedValue({ success: false })

    await expect(manager.reencryptAllItems()).rejects.toThrow('Failed to upload snapshots for batch starting at index 0')
  })

  it('continues processing remaining items if a single item fails to build snapshot', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockGetActiveSessionToken.mockResolvedValue('mock-token')
    mockListAutomergeItemIds.mockResolvedValue(['item-1', 'item-bad', 'item-2'])
    mockPutSnapshotsWithToken.mockResolvedValue({ success: true })

    mockRepo.find.mockImplementation(async (url: string) => {
      if (url === 'automerge:item-bad') {
        return {
          isReady: () => true,
          doc: () => {
            throw new Error('Corrupt document')
          },
        }
      }
      return {
        isReady: () => true,
        doc: () => ({ id: 'item-doc', type: 'note' }),
      }
    })

    const onProgress = vi.fn()
    await manager.reencryptAllItems(onProgress)

    expect(mockPutSnapshotsWithToken).toHaveBeenCalledTimes(1)
    const callArgs = mockPutSnapshotsWithToken.mock.calls[0][0]
    expect(callArgs.snapshots).toHaveLength(2)
    expect(callArgs.snapshots.map((s: any) => s.itemId)).toEqual(['item-1', 'item-2'])
    expect(onProgress).toHaveBeenCalledWith(3, 3)
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[ReencryptionManager] Failed to build snapshot for item item-bad:'),
      expect.any(Error)
    )
    consoleErrorSpy.mockRestore()
  })
})
