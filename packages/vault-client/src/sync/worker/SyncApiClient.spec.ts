import { SyncApiClient, AuthError, AuthExpiredError } from './SyncApiClient'

const mockPutSnapshots = vi.fn()
const mockPollSyncBatch = vi.fn()
vi.mock('./SyncWorkerClient', () => ({
  putSnapshots: (...args: any[]) => mockPutSnapshots(...args),
  pollSyncBatch: (...args: any[]) => mockPollSyncBatch(...args),
}))

const mockFetchManifest = vi.fn()
const mockFetchSnapshotsByIds = vi.fn()
vi.mock('./ItemClient', () => ({
  fetchManifest: (...args: any[]) => mockFetchManifest(...args),
  fetchSnapshotsByIds: (...args: any[]) => mockFetchSnapshotsByIds(...args),
}))

let runtimeToken = ''
vi.mock('../../api/runtime', () => ({
  getApiAuthToken: () => runtimeToken,
}))

/** A refresh that installs `token` as the realm's token, as the sync worker's does */
function refreshTo(token: string | null) {
  return vi.fn().mockImplementation(async () => {
    runtimeToken = token ?? ''
    return token
  })
}

describe('SyncApiClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runtimeToken = 'default-token'
  })

  describe('Token Acquisition', () => {
    it('uses the realm token without refreshing', async () => {
      runtimeToken = 'runtime-token-123'
      const refreshAuthToken = refreshTo('unused')
      const client = new SyncApiClient({ refreshAuthToken })

      expect(await client.getValidToken()).toBe('runtime-token-123')
      expect(refreshAuthToken).not.toHaveBeenCalled()
    })

    it('refreshes when the realm has no token', async () => {
      runtimeToken = ''
      const refreshAuthToken = refreshTo('refreshed-token-abc')
      const client = new SyncApiClient({ refreshAuthToken })

      expect(await client.getValidToken()).toBe('refreshed-token-abc')
      expect(refreshAuthToken).toHaveBeenCalledTimes(1)
    })

    it('returns null if there is no token and no refresh function', async () => {
      runtimeToken = ''
      const client = new SyncApiClient()

      expect(await client.getValidToken()).toBeNull()
      await expect(client.putSnapshots({ account: 'acc-1', snapshots: [] })).rejects.toThrow(AuthError)
      expect(mockPutSnapshots).not.toHaveBeenCalled()
    })

    it('falls back to the realm token when the refresh throws', async () => {
      runtimeToken = ''
      const refreshAuthToken = vi.fn().mockImplementation(async () => {
        runtimeToken = 'arrived-meanwhile'
        throw new Error('refresh failed')
      })
      const client = new SyncApiClient({ refreshAuthToken })

      expect(await client.getValidToken()).toBe('arrived-meanwhile')
    })
  })

  describe('Transparent 401 Retry', () => {
    it('retries putSnapshots transparently when receiving a 401 auth error', async () => {
      runtimeToken = 'stale-token'
      const refreshAuthToken = refreshTo('new-token')
      const client = new SyncApiClient({ refreshAuthToken })

      const tokensSent: string[] = []
      mockPutSnapshots.mockImplementation(async () => {
        tokensSent.push(runtimeToken)
        if (tokensSent.length === 1) {
          throw { data: { httpStatus: 401 }, message: 'UNAUTHORIZED' }
        }
        return { success: true, persisted: 1 }
      })

      const result = await client.putSnapshots({
        account: 'test-account',
        snapshots: [{ itemId: 'item-1' } as any],
      })

      expect(result).toEqual({ success: true, persisted: 1 })
      expect(tokensSent).toEqual(['stale-token', 'new-token'])
      expect(refreshAuthToken).toHaveBeenCalledTimes(1)
    })

    it('retries with a token that arrived while the refresh failed', async () => {
      runtimeToken = 'stale-token'
      const refreshAuthToken = vi.fn().mockImplementation(async () => {
        runtimeToken = 'newer-token'
        return null
      })
      const client = new SyncApiClient({ refreshAuthToken })

      mockPutSnapshots
        .mockRejectedValueOnce({ status: 401 })
        .mockResolvedValueOnce({ success: true, persisted: 2 })

      const result = await client.putSnapshots({
        account: 'test-account',
        snapshots: [{ itemId: 'item-1' } as any],
      })

      expect(result).toEqual({ success: true, persisted: 2 })
      expect(mockPutSnapshots).toHaveBeenCalledTimes(2)
    })

    it('throws AuthExpiredError if 401 occurs and token cannot be refreshed', async () => {
      runtimeToken = 'stale-token'
      const refreshAuthToken = vi.fn().mockResolvedValue(null)
      const client = new SyncApiClient({ refreshAuthToken })

      mockPutSnapshots.mockRejectedValue({
        data: { httpStatus: 401 },
        message: 'UNAUTHORIZED',
      })

      await expect(
        client.putSnapshots({
          account: 'test-account',
          snapshots: [{ itemId: 'item-1' } as any],
        })
      ).rejects.toThrow(AuthExpiredError)

      expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
    })

    it('throws AuthExpiredError if the refresh returns the rejected token', async () => {
      runtimeToken = 'same-token'
      const client = new SyncApiClient({ refreshAuthToken: refreshTo('same-token') })

      mockPutSnapshots.mockRejectedValue({ status: 401 })

      await expect(
        client.putSnapshots({ account: 'test-account', snapshots: [] })
      ).rejects.toThrow(AuthExpiredError)
      expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
    })

    it('throws AuthExpiredError if the retry is rejected too', async () => {
      runtimeToken = 'stale-token'
      const client = new SyncApiClient({ refreshAuthToken: refreshTo('new-token') })

      mockPutSnapshots.mockRejectedValue({ status: 401 })

      await expect(
        client.putSnapshots({ account: 'test-account', snapshots: [] })
      ).rejects.toThrow(AuthExpiredError)
      expect(mockPutSnapshots).toHaveBeenCalledTimes(2)
    })

    it('does not catch non-auth errors', async () => {
      const client = new SyncApiClient()

      const networkError = new Error('Network timeout')
      mockPutSnapshots.mockRejectedValue(networkError)

      await expect(
        client.putSnapshots({
          account: 'test-account',
          snapshots: [],
        })
      ).rejects.toThrow('Network timeout')

      expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
    })
  })

  describe('API Method Passthroughs', () => {
    it('passes through fetchManifest successfully', async () => {
      mockFetchManifest.mockResolvedValue({ manifest: [{ itemId: 'i1', modifiedAt: 100 }], serverTime: 5000 })
      const client = new SyncApiClient()

      const result = await client.fetchManifest({ account: 'acc-1' })
      expect(result).toEqual({ manifest: [{ itemId: 'i1', modifiedAt: 100 }], serverTime: 5000 })
      expect(mockFetchManifest).toHaveBeenCalledWith({ account: 'acc-1' }, undefined)
    })

    it('passes through fetchSnapshotsByIds successfully', async () => {
      mockFetchSnapshotsByIds.mockResolvedValue({ items: [{ item: 'i1' }], serverTime: 5000 })
      const client = new SyncApiClient()

      const result = await client.fetchSnapshotsByIds({ account: 'acc-1', itemIds: ['i1' as any] })
      expect(result).toEqual({ items: [{ item: 'i1' }], serverTime: 5000 })
      expect(mockFetchSnapshotsByIds).toHaveBeenCalledWith({ account: 'acc-1', itemIds: ['i1'] }, undefined)
    })

    it('passes through pollSyncBatch successfully', async () => {
      mockPollSyncBatch.mockResolvedValue({
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
      expect(mockPollSyncBatch).toHaveBeenCalledWith({ account: 'acc-1', pullCursors: {} }, undefined)
    })
  })
})
