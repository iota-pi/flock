import { ReencryptionManager } from './reencryptionManager'

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
  toAutomergeUrlFromItemId: vi.fn().mockReturnValue('automerge:item-1'),
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
})
