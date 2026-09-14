import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SyncApiClient, AuthExpiredError } from './SyncApiClient'

const mockPutSnapshotsWithToken = vi.fn()
const mockPollSyncBatchWithToken = vi.fn()
vi.mock('../../api/vault/SyncWorkerClient', () => ({
  putSnapshotsWithToken: (...args: any[]) => mockPutSnapshotsWithToken(...args),
  pollSyncBatchWithToken: (...args: any[]) => mockPollSyncBatchWithToken(...args),
}))

const mockFetchManifest = vi.fn()
const mockFetchSnapshotsByIds = vi.fn()
vi.mock('../../api/vault/ItemClient', () => ({
  fetchManifest: (...args: any[]) => mockFetchManifest(...args),
  fetchSnapshotsByIds: (...args: any[]) => mockFetchSnapshotsByIds(...args),
}))

const mockGetMetadata = vi.fn()
vi.mock('src/api/trpcClient', () => ({
  getTrpcClient: () => ({
    accounts: {
      getMetadata: {
        query: (...args: any[]) => mockGetMetadata(...args),
      },
    },
  }),
}))

const mockSetApiAuthToken = vi.fn()
const mockHasApiAuthToken = vi.fn().mockReturnValue(false)
const mockGetApiAuthToken = vi.fn().mockReturnValue('')
vi.mock('../../api/runtime', () => ({
  setApiAuthToken: (...args: any[]) => mockSetApiAuthToken(...args),
  hasApiAuthToken: () => mockHasApiAuthToken(),
  getApiAuthToken: () => mockGetApiAuthToken(),
}))

const mockGetActiveSessionToken = vi.fn()
vi.mock('../shared/workerAuthStore', () => ({
  getActiveSessionToken: () => mockGetActiveSessionToken(),
}))

describe('SyncApiClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockHasApiAuthToken.mockReturnValue(false)
    mockGetApiAuthToken.mockReturnValue('')
    mockGetActiveSessionToken.mockResolvedValue('default-store-token')
  })

  describe('Token Acquisition', () => {
    it('acquires token from store and synchronizes with runtime', async () => {
      mockGetActiveSessionToken.mockResolvedValue('store-token-123')
      const client = new SyncApiClient()

      const token = await client.getValidToken()
      expect(token).toBe('store-token-123')
      expect(mockSetApiAuthToken).toHaveBeenCalledWith('store-token-123')
      expect(await client.hasAuthToken()).toBe(true)
      expect(client.getToken()).toBe('store-token-123')
    })

    it('falls back to refreshAuthToken if store token is null', async () => {
      mockGetActiveSessionToken.mockResolvedValue(null)
      const refreshAuthToken = vi.fn().mockResolvedValue('refreshed-token-abc')
      const client = new SyncApiClient({ refreshAuthToken })

      const token = await client.getValidToken()
      expect(token).toBe('refreshed-token-abc')
      expect(refreshAuthToken).toHaveBeenCalledTimes(1)
      expect(mockSetApiAuthToken).toHaveBeenCalledWith('refreshed-token-abc')
    })

    it('returns null if no token in store and no refresh function', async () => {
      mockGetActiveSessionToken.mockResolvedValue(null)
      const client = new SyncApiClient()

      const token = await client.getValidToken()
      expect(token).toBeNull()
      expect(await client.hasAuthToken()).toBe(false)
      expect(() => client.getToken()).toThrow('No active session token available')
    })
  })

  describe('Transparent 401 Retry', () => {
    it('retries putSnapshots transparently when receiving a 401 auth error', async () => {
      mockGetActiveSessionToken.mockResolvedValueOnce('stale-token')
      const refreshAuthToken = vi.fn().mockResolvedValue('new-token')
      const client = new SyncApiClient({ refreshAuthToken })

      mockPutSnapshotsWithToken
        .mockRejectedValueOnce({ data: { httpStatus: 401 }, message: 'UNAUTHORIZED' })
        .mockResolvedValueOnce({ success: true, persisted: 1 })

      const result = await client.putSnapshots({
        account: 'test-account',
        snapshots: [{ itemId: 'item-1' } as any],
      })

      expect(result).toEqual({ success: true, persisted: 1 })
      expect(mockPutSnapshotsWithToken).toHaveBeenCalledTimes(2)
      expect(mockPutSnapshotsWithToken.mock.calls[0][0].authToken).toBe('stale-token')
      expect(mockPutSnapshotsWithToken.mock.calls[1][0].authToken).toBe('new-token')
      expect(refreshAuthToken).toHaveBeenCalledTimes(1)
    })

    it('retries when newer token is discovered in store on 401', async () => {
      mockGetActiveSessionToken
        .mockResolvedValueOnce('stale-token')
        .mockResolvedValueOnce('newer-store-token')
      const client = new SyncApiClient()

      mockPutSnapshotsWithToken
        .mockRejectedValueOnce({ status: 401 })
        .mockResolvedValueOnce({ success: true, persisted: 2 })

      const result = await client.putSnapshots({
        account: 'test-account',
        snapshots: [{ itemId: 'item-1' } as any],
      })

      expect(result).toEqual({ success: true, persisted: 2 })
      expect(mockPutSnapshotsWithToken).toHaveBeenCalledTimes(2)
      expect(mockPutSnapshotsWithToken.mock.calls[0][0].authToken).toBe('stale-token')
      expect(mockPutSnapshotsWithToken.mock.calls[1][0].authToken).toBe('newer-store-token')
    })

    it('throws AuthExpiredError if 401 occurs and token cannot be refreshed', async () => {
      mockGetActiveSessionToken.mockResolvedValue('stale-token')
      const refreshAuthToken = vi.fn().mockResolvedValue(null)
      const client = new SyncApiClient({ refreshAuthToken })

      mockPutSnapshotsWithToken.mockRejectedValue({
        data: { httpStatus: 401 },
        message: 'UNAUTHORIZED',
      })

      await expect(
        client.putSnapshots({
          account: 'test-account',
          snapshots: [{ itemId: 'item-1' } as any],
        })
      ).rejects.toThrow(AuthExpiredError)

      expect(mockPutSnapshotsWithToken).toHaveBeenCalledTimes(1)
    })

    it('coalesces concurrent token refreshes into a single call', async () => {
      mockGetActiveSessionToken.mockResolvedValue('initial-token')
      let resolveRefresh: (t: string) => void
      const refreshPromise = new Promise<string>(resolve => {
        resolveRefresh = resolve
      })
      const refreshAuthToken = vi.fn().mockImplementation(() => refreshPromise)

      const client = new SyncApiClient({ refreshAuthToken })

      mockFetchManifest
        .mockRejectedValueOnce({ data: { httpStatus: 401 } })
        .mockResolvedValueOnce({ manifest: [], serverTime: 1000 })

      mockFetchSnapshotsByIds
        .mockRejectedValueOnce({ data: { httpStatus: 401 } })
        .mockResolvedValueOnce({ items: [], serverTime: 1000 })

      const p1 = client.fetchManifest({ account: 'acc-1' })
      const p2 = client.fetchSnapshotsByIds({ account: 'acc-1', itemIds: ['i1' as any] })

      // Wait a tick for both to hit 401 and trigger refresh
      await new Promise(r => setTimeout(r, 10))

      expect(refreshAuthToken).toHaveBeenCalledTimes(1)

      resolveRefresh!('shared-new-token')

      const [res1, res2] = await Promise.all([p1, p2])
      expect(res1).toEqual({ manifest: [], serverTime: 1000 })
      expect(res2).toEqual({ items: [], serverTime: 1000 })
      expect(refreshAuthToken).toHaveBeenCalledTimes(1)
    })

    it('does not catch non-auth errors', async () => {
      mockGetActiveSessionToken.mockResolvedValue('valid-token')
      const client = new SyncApiClient()

      const networkError = new Error('Network timeout')
      mockPutSnapshotsWithToken.mockRejectedValue(networkError)

      await expect(
        client.putSnapshots({
          account: 'test-account',
          snapshots: [],
        })
      ).rejects.toThrow('Network timeout')

      expect(mockPutSnapshotsWithToken).toHaveBeenCalledTimes(1)
    })
  })

  describe('API Method Passthroughs', () => {
    it('passes through fetchManifest successfully', async () => {
      mockFetchManifest.mockResolvedValue({ manifest: [['i1', 100]], serverTime: 5000 })
      const client = new SyncApiClient()

      const result = await client.fetchManifest({ account: 'acc-1' })
      expect(result).toEqual({ manifest: [['i1', 100]], serverTime: 5000 })
      expect(mockFetchManifest).toHaveBeenCalledWith({ account: 'acc-1' })
    })

    it('passes through fetchSnapshotsByIds successfully', async () => {
      mockFetchSnapshotsByIds.mockResolvedValue({ items: [{ item: 'i1' }], serverTime: 5000 })
      const client = new SyncApiClient()

      const result = await client.fetchSnapshotsByIds({ account: 'acc-1', itemIds: ['i1' as any] })
      expect(result).toEqual({ items: [{ item: 'i1' }], serverTime: 5000 })
      expect(mockFetchSnapshotsByIds).toHaveBeenCalledWith({ account: 'acc-1', itemIds: ['i1'] })
    })

    it('passes through getAccountMetadata successfully', async () => {
      mockGetMetadata.mockResolvedValue({
        success: true,
        metadata: { theme: 'dark' },
      })
      const client = new SyncApiClient()

      const result = await client.getAccountMetadata({ account: 'acc-1' })
      expect(result).toEqual({ theme: 'dark' })
      expect(mockGetMetadata).toHaveBeenCalledWith({ account: 'acc-1' })
    })

    it('passes through pollSyncBatch successfully', async () => {
      mockPollSyncBatchWithToken.mockResolvedValue({
        success: true,
        pushResults: [],
        pullResults: [],
      })
      const client = new SyncApiClient()

      const result = await client.pollSyncBatch({
        account: 'acc-1',
        pullCursors: {},
      } as any)

      expect(result.success).toBe(true)
      expect(mockPollSyncBatchWithToken).toHaveBeenCalledWith(
        expect.objectContaining({ account: 'acc-1', authToken: 'default-store-token' }),
        undefined
      )
    })
  })
})
