import { reencryptAllItems } from './reencryptAllItems'
import { upsertManualRecoveryEntry } from '../shared/manualRecoveryStore'

const mockPutSnapshotsWithToken = vi.fn()
const mockGetActiveSessionToken = vi.fn()
const mockListAutomergeItemIds = vi.fn()

vi.mock('../../api/vault/SyncWorkerClient', () => ({
  putSnapshotsWithToken: (...args: any[]) => mockPutSnapshotsWithToken(...args),
}))

vi.mock('../shared/workerAuthStore', () => ({
  getActiveSessionToken: () => mockGetActiveSessionToken(),
}))

vi.mock('../shared/manualRecoveryStore', () => ({
  upsertManualRecoveryEntry: vi.fn().mockResolvedValue({ id: 'mock-entry' }),
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

describe('reencryptAllItems', () => {
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
  })

  it('throws an error if accountId or repo is missing', async () => {
    context.accountId = null
    await expect(reencryptAllItems(context as any)).rejects.toThrow('SyncWorker not initialized')

    context.accountId = 'test-account'
    context.repo = null
    await expect(reencryptAllItems(context as any)).rejects.toThrow('SyncWorker not initialized')
  })

  it('throws an error if authToken is missing', async () => {
    mockGetActiveSessionToken.mockResolvedValue(null)
    await expect(reencryptAllItems(context as any)).rejects.toThrow('No active session token available')
  })

  it('handles empty item list', async () => {
    mockGetActiveSessionToken.mockResolvedValue('mock-token')
    mockListAutomergeItemIds.mockResolvedValue([])

    const onProgress = vi.fn()
    const result = await reencryptAllItems(context as any, onProgress)

    expect(result).toEqual({ succeeded: [], failed: [] })
    expect(onProgress).toHaveBeenCalledWith(0, 0)
    expect(mockPutSnapshotsWithToken).not.toHaveBeenCalled()
  })

  it('successfully processes and uploads items in batches', async () => {
    mockGetActiveSessionToken.mockResolvedValue('mock-token')
    mockListAutomergeItemIds.mockResolvedValue(['item-1', 'item-2'])
    mockPutSnapshotsWithToken.mockResolvedValue({ success: true })

    const onProgress = vi.fn()
    const result = await reencryptAllItems(context as any, onProgress)

    expect(result).toEqual({
      succeeded: ['item-1', 'item-2'],
      failed: [],
    })
    expect(mockPutSnapshotsWithToken).toHaveBeenCalledTimes(1)
    expect(onProgress).toHaveBeenCalledWith(2, 2)
  })

  it('records failed items and quarantines to manual recovery store if server upload fails', async () => {
    mockGetActiveSessionToken.mockResolvedValue('mock-token')
    mockListAutomergeItemIds.mockResolvedValue(['item-1'])
    mockPutSnapshotsWithToken.mockResolvedValue({ success: false })

    const result = await reencryptAllItems(context as any)

    expect(result.succeeded).toEqual([])
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].itemId).toBe('item-1')
    expect(result.failed[0].error).toContain('Failed to upload snapshots')
    expect(upsertManualRecoveryEntry).toHaveBeenCalledWith('test-account', {
      itemId: 'item-1',
      reason: expect.stringContaining('Re-encryption upload failed'),
    })
  })

  it('continues processing remaining batches if a single batch upload fails', async () => {
    mockGetActiveSessionToken.mockResolvedValue('mock-token')
    // 12 items -> batch 1 (0-10), batch 2 (10-12)
    const items = Array.from({ length: 12 }, (_, i) => `item-${i}`)
    mockListAutomergeItemIds.mockResolvedValue(items)

    // First batch fails upload 3 times, second batch succeeds
    mockPutSnapshotsWithToken
      .mockResolvedValueOnce({ success: false })
      .mockResolvedValueOnce({ success: false })
      .mockResolvedValueOnce({ success: false })
      .mockResolvedValueOnce({ success: true })

    const onProgress = vi.fn()
    const result = await reencryptAllItems(context as any, onProgress)

    expect(result.succeeded).toHaveLength(2)
    expect(result.succeeded).toEqual(['item-10', 'item-11'])
    expect(result.failed).toHaveLength(10)

    // 3 attempts for batch 1 + 1 attempt for batch 2 = 4 calls
    expect(mockPutSnapshotsWithToken).toHaveBeenCalledTimes(4)
    expect(onProgress).toHaveBeenCalledWith(10, 12)
    expect(onProgress).toHaveBeenCalledWith(12, 12)
  })

  it('continues processing remaining items if a single item fails to build snapshot and quarantines it', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockGetActiveSessionToken.mockResolvedValue('mock-token')
    mockListAutomergeItemIds.mockResolvedValue(['item-1', 'item-bad', 'item-2'])
    mockPutSnapshotsWithToken.mockResolvedValue({ success: true })

    let badItemAttempts = 0
    mockRepo.find.mockImplementation(async (url: string) => {
      if (url === 'automerge:item-bad') {
        badItemAttempts += 1
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
    const result = await reencryptAllItems(context as any, onProgress)

    expect(result.succeeded).toEqual(['item-1', 'item-2'])
    expect(result.failed).toEqual([
      { itemId: 'item-bad', error: expect.stringContaining('Corrupt document') },
    ])
    expect(upsertManualRecoveryEntry).toHaveBeenCalledWith('test-account', {
      itemId: 'item-bad',
      reason: expect.stringContaining('Corrupt document'),
    })

    // Should have retried bad item 3 times
    expect(badItemAttempts).toBe(3)
    expect(mockPutSnapshotsWithToken).toHaveBeenCalledTimes(1)
    const callArgs = mockPutSnapshotsWithToken.mock.calls[0][0]
    expect(callArgs.snapshots).toHaveLength(2)
    expect(callArgs.snapshots.map((s: any) => s.itemId)).toEqual(['item-1', 'item-2'])
    expect(onProgress).toHaveBeenCalledWith(3, 3)

    consoleErrorSpy.mockRestore()
    consoleWarnSpy.mockRestore()
  })

  it('dynamically picks up a new auth token between batches', async () => {
    const items = Array.from({ length: 12 }, (_, i) => `item-${i}`)
    mockListAutomergeItemIds.mockResolvedValue(items)

    mockGetActiveSessionToken
      .mockResolvedValueOnce('token-1')
      .mockResolvedValueOnce('token-1')
      .mockResolvedValueOnce('token-2')
    mockPutSnapshotsWithToken.mockResolvedValue({ success: true })

    const result = await reencryptAllItems(context as any)

    expect(result.succeeded).toHaveLength(12)
    expect(mockPutSnapshotsWithToken).toHaveBeenCalledTimes(2)
    expect(mockPutSnapshotsWithToken.mock.calls[0][0].authToken).toBe('token-1')
    expect(mockPutSnapshotsWithToken.mock.calls[1][0].authToken).toBe('token-2')
  })

  it('recovers from 401 auth error using refreshAuthToken and retries successfully', async () => {
    mockGetActiveSessionToken.mockResolvedValue('old-token')
    mockListAutomergeItemIds.mockResolvedValue(['item-1', 'item-2'])

    const refreshAuthToken = vi.fn().mockResolvedValue('refreshed-token')
    const deps = {
      ...context,
      refreshAuthToken,
    }

    mockPutSnapshotsWithToken
      .mockRejectedValueOnce({ data: { httpStatus: 401 }, message: 'UNAUTHORIZED' })
      .mockResolvedValueOnce({ success: true })

    const result = await reencryptAllItems(deps as any)

    expect(refreshAuthToken).toHaveBeenCalledTimes(1)
    expect(mockPutSnapshotsWithToken).toHaveBeenCalledTimes(2)
    expect(mockPutSnapshotsWithToken.mock.calls[0][0].authToken).toBe('old-token')
    expect(mockPutSnapshotsWithToken.mock.calls[1][0].authToken).toBe('refreshed-token')
    expect(result.succeeded).toEqual(['item-1', 'item-2'])
    expect(result.failed).toEqual([])
    expect(upsertManualRecoveryEntry).not.toHaveBeenCalled()
  })

  it('recovers from 401 auth error when a newer token is in store', async () => {
    mockGetActiveSessionToken
      .mockResolvedValueOnce('stale-token')
      .mockResolvedValueOnce('stale-token')
      .mockResolvedValueOnce('new-store-token')
    mockListAutomergeItemIds.mockResolvedValue(['item-1'])

    mockPutSnapshotsWithToken
      .mockRejectedValueOnce({ data: { httpStatus: 401 } })
      .mockResolvedValueOnce({ success: true })

    const result = await reencryptAllItems(context as any)

    expect(mockPutSnapshotsWithToken).toHaveBeenCalledTimes(2)
    expect(mockPutSnapshotsWithToken.mock.calls[0][0].authToken).toBe('stale-token')
    expect(mockPutSnapshotsWithToken.mock.calls[1][0].authToken).toBe('new-store-token')
    expect(result.succeeded).toEqual(['item-1'])
    expect(upsertManualRecoveryEntry).not.toHaveBeenCalled()
  })

  it('aborts immediately and DOES NOT quarantine items when auth error cannot be resolved', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const items = Array.from({ length: 20 }, (_, i) => `item-${i}`)
    mockListAutomergeItemIds.mockResolvedValue(items)
    mockGetActiveSessionToken.mockResolvedValue('expired-token')

    mockPutSnapshotsWithToken.mockRejectedValue({
      data: { httpStatus: 401 },
      message: 'UNAUTHORIZED',
    })

    await expect(reencryptAllItems(context as any)).rejects.toThrow(
      /Re-encryption aborted: authentication session expired/
    )

    // CRITICAL: Items must NOT be quarantined into manualRecoveryStore
    expect(upsertManualRecoveryEntry).not.toHaveBeenCalled()
    // CRITICAL: Subsequent batches must NOT be processed (only attempt 1 was made before aborting)
    expect(mockPutSnapshotsWithToken).toHaveBeenCalledTimes(1)

    consoleWarnSpy.mockRestore()
  })

  it('initializes token via refreshAuthToken if initial getActiveSessionToken is empty', async () => {
    mockGetActiveSessionToken.mockResolvedValue(null)
    const refreshAuthToken = vi.fn().mockResolvedValue('recovered-token')
    mockListAutomergeItemIds.mockResolvedValue(['item-1'])
    mockPutSnapshotsWithToken.mockResolvedValue({ success: true })

    const deps = {
      ...context,
      refreshAuthToken,
    }

    const result = await reencryptAllItems(deps as any)

    expect(refreshAuthToken).toHaveBeenCalledTimes(1)
    expect(result.succeeded).toEqual(['item-1'])
    expect(mockPutSnapshotsWithToken).toHaveBeenCalledWith(
      expect.objectContaining({ authToken: 'recovered-token' })
    )
  })
})
