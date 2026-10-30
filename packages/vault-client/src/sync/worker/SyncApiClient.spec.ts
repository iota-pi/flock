import { SyncApiClient, AuthError, AuthExpiredError, toAuthExpiredError } from './SyncApiClient'
import * as runtimeModule from '../../api/runtime'
import { spyOnExports } from '../../../test/moduleMocks'
import { spyOnVaultTrpc } from './__test__/testUtils'

const mockPutSnapshots = vi.fn()
const mockPollSyncBatch = vi.fn()
const mockFetchManifest = vi.fn()
const mockFetchSnapshotsByIds = vi.fn()
let runtimeToken = ''
/** A refresh that installs `token` as the realm's token, as the sync worker's does */
function refreshTo(token: string | null) {
  return vi.fn().mockImplementation(async () => {
    runtimeToken = token ?? ''
    return token
  })
}

beforeEach(() => {
  spyOnVaultTrpc({
    putSnapshots: (...args: any[]) => mockPutSnapshots(...args),
    pollSync: (...args: any[]) => mockPollSyncBatch(...args),
    fetchManifest: (...args: any[]) => mockFetchManifest(...args),
    fetchSnapshotsByIds: (...args: any[]) => mockFetchSnapshotsByIds(...args),
  })
  spyOnExports(runtimeModule, {
    getApiAuthToken: () => runtimeToken,
  })
})

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
      mockFetchManifest.mockResolvedValue({ success: true, manifest: [{ itemId: 'i1', modifiedAt: 100 }], serverTime: 5000 })
      const client = new SyncApiClient()

      const result = await client.fetchManifest({ account: 'acc-1' })
      expect(result).toEqual({ manifest: [{ itemId: 'i1', modifiedAt: 100 }], serverTime: 5000 })
      expect(mockFetchManifest).toHaveBeenCalledWith({ account: 'acc-1' }, undefined)
    })

    it('passes through fetchSnapshotsByIds successfully', async () => {
      mockFetchSnapshotsByIds.mockResolvedValue({ success: true, items: [{ item: 'i1' }], serverTime: 5000 })
      const client = new SyncApiClient()

      const result = await client.fetchSnapshotsByIds({ account: 'acc-1', itemIds: ['i1' as any] })
      expect(result).toEqual({ items: [{ item: 'i1' }], serverTime: 5000 })
      expect(mockFetchSnapshotsByIds).toHaveBeenCalledWith({ account: 'acc-1', itemIds: ['i1'] }, undefined)
    })

    it('throws when fetchManifest reports failure', async () => {
      mockFetchManifest.mockResolvedValue({ success: false, manifest: [], serverTime: 5000 })
      const client = new SyncApiClient()

      await expect(client.fetchManifest({ account: 'acc-1' })).rejects.toThrow(
        'Vault client fetchManifest operation failed'
      )
    })

    it('throws when fetchSnapshotsByIds reports failure', async () => {
      mockFetchSnapshotsByIds.mockResolvedValue({ success: false, items: [], serverTime: 5000 })
      const client = new SyncApiClient()

      await expect(client.fetchSnapshotsByIds({ account: 'acc-1', itemIds: ['i1' as any] })).rejects.toThrow(
        'Vault client fetchSnapshotsByIds operation failed'
      )
    })

    it('rejects invalid fetch input before calling the server', async () => {
      const client = new SyncApiClient()

      await expect(client.fetchManifest({ account: '' })).rejects.toThrow()
      expect(mockFetchManifest).not.toHaveBeenCalled()
    })

    it('passes through putSnapshots with its options', async () => {
      mockPutSnapshots.mockResolvedValue({ success: true, persisted: 0 })
      const client = new SyncApiClient()
      const signal = new AbortController().signal

      await client.putSnapshots({ account: 'acc-1', snapshots: [] }, { signal })
      expect(mockPutSnapshots).toHaveBeenCalledWith({ account: 'acc-1', snapshots: [] }, { signal })
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

  describe('toAuthExpiredError', () => {
    it('returns an AuthExpiredError unchanged', () => {
      const err = new AuthExpiredError('already')
      expect(toAuthExpiredError(err)).toBe(err)
    })

    it('takes the message of an Error', () => {
      const cause = new Error('bad token')
      const err = toAuthExpiredError(cause)
      expect(err.message).toBe('Authentication session expired (bad token)')
      expect(err.cause).toBe(cause)
    })

    it('takes a string message from a plain object', () => {
      expect(toAuthExpiredError({ message: 'UNAUTHORIZED' }).message)
        .toBe('Authentication session expired (UNAUTHORIZED)')
    })

    it('stringifies anything else', () => {
      expect(toAuthExpiredError('nope').message).toBe('Authentication session expired (nope)')
      expect(toAuthExpiredError(null).message).toBe('Authentication session expired (null)')
      expect(toAuthExpiredError({ message: 401 }).message)
        .toBe('Authentication session expired ([object Object])')
    })
  })
})
