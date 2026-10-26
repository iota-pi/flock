import { ItemReencryptor, type ItemReencryptorOptions } from './reencryptAllItems'
import { RecoveryManager } from './RecoveryManager'
import { ClientEventHub } from './SyncEventHub'
import { passthroughCodec } from './domain'
import { SyncApiClient } from './SyncApiClient'
import { upsertManualRecoveryEntry } from '../shared/manualRecoveryStore'
import { BuildSnapshotResult } from './snapshotBuilder'
import { createMockKeyProvider, createMockVault } from './__test__/testUtils'
import { spyOnExports } from '../../../test/moduleMocks'
import { getApiAuthToken, setApiAuthToken } from '../../api/runtime'
import * as syncWorkerClient from './SyncWorkerClient'
import * as manualRecoveryStoreModule from '../shared/manualRecoveryStore'
import * as docStoreModule from './docStore'
import * as automergeModule from './utils/automerge'
import * as Automerge from '@automerge/automerge/slim'

const mockPutSnapshots = vi.fn()
const mockListAutomergeItemIds = vi.fn()

const vault = {
  ...createMockVault(),
  encryptBytes: vi.fn().mockResolvedValue({
    iv: 'mock-iv',
    cipher: 'mock-cipher',
    kver: '1',
  }),
}
const keys = createMockKeyProvider(vault)

/** Dependencies for a reencryptor whose pipeline stages are called directly */
function stageDeps(overrides: Partial<ItemReencryptorOptions> = {}): ItemReencryptorOptions {
  return {
    accountId: 'test-account',
    repo: {} as any,
    indexManager: {} as any,
    apiClient: new SyncApiClient(),
    recoveryManager: new RecoveryManager({ accountId: 'test-account', eventHub: new ClientEventHub() }),
    codec: passthroughCodec,
    keys,
    ...overrides,
  }
}

beforeEach(() => {
  spyOnExports(syncWorkerClient, {
    putSnapshots: (...args: any[]) => mockPutSnapshots(...args),
  })
  spyOnExports(manualRecoveryStoreModule, {
    upsertManualRecoveryEntry: vi.fn().mockResolvedValue({ id: 'mock-entry' }),
  })
  spyOnExports(docStoreModule, {
    normalizeItemSnapshot: vi.fn().mockReturnValue({
      type: 'note',
      deleted: false,
    }),
    AutomergeIndexManager: vi.fn().mockImplementation(() => ({
      listAutomergeItemIds: () => mockListAutomergeItemIds(),
    })),
  })
  spyOnExports(automergeModule, {
    toAutomergeUrlFromItemId: vi.fn().mockImplementation((id: string) => `automerge:${id}`),
  })
  spyOnExports(Automerge, {
    save: vi.fn().mockReturnValue(new Uint8Array([1, 2, 3])),
    getHeads: vi.fn().mockReturnValue(['mock-head']),
  })
})

describe('reencryptAllItems', () => {
  let mockRepo: any
  let mockHandle: any
  let itemReencryptor: ItemReencryptor
  let context: Omit<ItemReencryptorOptions, 'keys'>

  beforeEach(() => {
    vi.clearAllMocks()
    setApiAuthToken('')

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
      apiClient: new SyncApiClient(),
      recoveryManager: new RecoveryManager({ accountId: 'test-account', eventHub: new ClientEventHub() }),
      codec: passthroughCodec,
    }
    itemReencryptor = new ItemReencryptor({ ...context, keys })
  })

  afterEach(() => {
    itemReencryptor.cancelScheduled()
  })

  it('throws an error if there is no session token', async () => {
    setApiAuthToken('')
    await expect(itemReencryptor.reencryptAllItems()).rejects.toThrow('No active session token available')
  })

  it('handles empty item list', async () => {
    setApiAuthToken('mock-token')
    mockListAutomergeItemIds.mockResolvedValue([])

    const onProgress = vi.fn()
    const result = await itemReencryptor.reencryptAllItems({ onProgress })

    expect(result).toEqual({ succeeded: [], failed: [] })
    expect(onProgress).toHaveBeenCalledWith(0, 0)
    expect(mockPutSnapshots).not.toHaveBeenCalled()
  })

  it('successfully processes and uploads items in batches', async () => {
    setApiAuthToken('mock-token')
    mockListAutomergeItemIds.mockResolvedValue(['item-1', 'item-2'])
    mockPutSnapshots.mockResolvedValue({ success: true })

    const onProgress = vi.fn()
    const result = await itemReencryptor.reencryptAllItems({ onProgress })

    expect(result).toEqual({
      succeeded: ['item-1', 'item-2'],
      failed: [],
    })
    expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
    expect(onProgress).toHaveBeenCalledWith(2, 2)
  })

  it('reports the versions and heads of the snapshots the server stored', async () => {
    const onSnapshotsStored = vi.fn()
    const reencryptor = new ItemReencryptor({ ...context, keys, onSnapshotsStored })
    setApiAuthToken('mock-token')
    mockListAutomergeItemIds.mockResolvedValue(['item-1', 'item-2'])
    mockPutSnapshots.mockResolvedValue({
      success: true,
      persisted: 2,
      results: [{ itemId: 'item-1', version: 4 }, { itemId: 'item-2', version: 9 }],
    })

    await reencryptor.reencryptAllItems()

    expect(onSnapshotsStored).toHaveBeenCalledWith([
      { itemId: 'item-1', version: 4, heads: ['mock-head'] },
      { itemId: 'item-2', version: 9, heads: ['mock-head'] },
    ])
  })

  it('records failed items and quarantines to manual recovery store if server upload fails', async () => {
    setApiAuthToken('mock-token')
    mockListAutomergeItemIds.mockResolvedValue(['item-1'])
    mockPutSnapshots.mockResolvedValue({ success: false })

    const result = await itemReencryptor.reencryptAllItems()

    expect(result).toEqual({
      succeeded: [],
      failed: [
        {
          itemId: 'item-1',
          error: expect.stringContaining('Failed to upload snapshots'),
        },
      ],
    })
    expect(upsertManualRecoveryEntry).toHaveBeenCalledWith('test-account', {
      itemId: 'item-1',
      kind: 'snapshotFailure',
      reason: expect.stringContaining('Re-encryption upload failed'),
    })
  })

  it('continues processing remaining batches if a single batch upload fails', async () => {
    setApiAuthToken('mock-token')
    // 12 items -> batch 1 (0-10), batch 2 (10-12)
    const items = Array.from({ length: 12 }, (_, i) => `item-${i}`)
    mockListAutomergeItemIds.mockResolvedValue(items)

    // First batch fails upload 3 times, second batch succeeds
    mockPutSnapshots
      .mockResolvedValueOnce({ success: false })
      .mockResolvedValueOnce({ success: false })
      .mockResolvedValueOnce({ success: false })
      .mockResolvedValueOnce({ success: true })

    const onProgress = vi.fn()
    const result = await itemReencryptor.reencryptAllItems({ onProgress })

    expect(result.succeeded).toHaveLength(2)
    expect(result.succeeded).toEqual(['item-10', 'item-11'])
    expect(result.failed).toHaveLength(10)

    // 3 attempts for batch 1 + 1 attempt for batch 2 = 4 calls
    expect(mockPutSnapshots).toHaveBeenCalledTimes(4)
    expect(onProgress).toHaveBeenCalledWith(10, 12)
    expect(onProgress).toHaveBeenCalledWith(12, 12)
  })

  it('continues processing remaining items if a single item fails to build snapshot and quarantines it', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setApiAuthToken('mock-token')
    mockListAutomergeItemIds.mockResolvedValue(['item-1', 'item-bad', 'item-2'])
    mockPutSnapshots.mockResolvedValue({ success: true })

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
    const result = await itemReencryptor.reencryptAllItems({ onProgress })

    expect(result.succeeded).toEqual(['item-1', 'item-2'])
    expect(result.failed).toEqual([
      { itemId: 'item-bad', error: expect.stringContaining('Corrupt document') },
    ])
    expect(upsertManualRecoveryEntry).toHaveBeenCalledWith('test-account', {
      itemId: 'item-bad',
      kind: 'snapshotFailure',
      reason: expect.stringContaining('Corrupt document'),
    })

    // Should have retried bad item 3 times
    expect(badItemAttempts).toBe(3)
    expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
    const callArgs = mockPutSnapshots.mock.calls[0][0]
    expect(callArgs.snapshots).toHaveLength(2)
    expect(callArgs.snapshots.map((s: any) => s.itemId)).toEqual(['item-1', 'item-2'])
    expect(onProgress).toHaveBeenCalledWith(3, 3)

    consoleErrorSpy.mockRestore()
    consoleWarnSpy.mockRestore()
  })

  it('continues processing remaining items if buildSnapshot returns type error and quarantines it', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setApiAuthToken('mock-token')
    mockListAutomergeItemIds.mockResolvedValue(['item-1', 'item-bad-doc', 'item-2'])
    mockPutSnapshots.mockResolvedValue({ success: true })

    mockRepo.find.mockImplementation(async (url: string) => {
      if (url === 'automerge:item-bad-doc') {
        return {
          isReady: () => true,
          doc: () => null,
        }
      }
      return {
        isReady: () => true,
        doc: () => ({ id: 'item-doc', type: 'note' }),
      }
    })

    const onProgress = vi.fn()
    const result = await itemReencryptor.reencryptAllItems({ onProgress })

    expect(result.succeeded).toEqual(['item-1', 'item-2'])
    expect(result.failed).toEqual([
      {
        itemId: 'item-bad-doc',
        error: 'Failed to build snapshot for item item-bad-doc: Document data not available',
      },
    ])
    expect(upsertManualRecoveryEntry).toHaveBeenCalledWith('test-account', {
      itemId: 'item-bad-doc',
      kind: 'snapshotFailure',
      reason: 'Re-encryption snapshot build failed: Failed to build snapshot for item item-bad-doc: Document data not available',
    })
    expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
    expect(onProgress).toHaveBeenCalledWith(3, 3)

    consoleErrorSpy.mockRestore()
    consoleWarnSpy.mockRestore()
  })

  it('retries when buildSnapshot returns not-ready and succeeds if subsequent attempt is ready', async () => {
    setApiAuthToken('mock-token')
    mockListAutomergeItemIds.mockResolvedValue(['item-retry'])
    mockPutSnapshots.mockResolvedValue({ success: true })

    let attempts = 0
    mockRepo.find.mockImplementation(async () => {
      attempts += 1
      if (attempts === 1) {
        return {
          isReady: () => false,
          doc: () => ({ id: 'item-retry', type: 'note' }),
        }
      }
      return {
        isReady: () => true,
        doc: () => ({ id: 'item-retry', type: 'note' }),
      }
    })

    const onProgress = vi.fn()
    const result = await itemReencryptor.reencryptAllItems({ onProgress })

    expect(attempts).toBe(2)
    expect(result.succeeded).toEqual(['item-retry'])
    expect(result.failed).toEqual([])
    expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
  })

  it('retries when buildSnapshot returns not-ready and records item as failed and quarantined if retries are exhausted', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setApiAuthToken('mock-token')
    mockListAutomergeItemIds.mockResolvedValue(['item-always-not-ready'])

    let attempts = 0
    mockRepo.find.mockImplementation(async () => {
      attempts += 1
      return {
        isReady: () => false,
        doc: () => ({ id: 'item-always-not-ready', type: 'note' }),
      }
    })

    const result = await itemReencryptor.reencryptAllItems()

    expect(attempts).toBe(3)
    expect(result.succeeded).toEqual([])
    expect(result.failed).toEqual([
      {
        itemId: 'item-always-not-ready',
        error: 'Failed to build snapshot for item item-always-not-ready: Item item-always-not-ready document or vault was not ready',
      },
    ])
    expect(upsertManualRecoveryEntry).toHaveBeenCalledWith('test-account', {
      itemId: 'item-always-not-ready',
      kind: 'snapshotFailure',
      reason: 'Re-encryption snapshot build failed: Failed to build snapshot for item item-always-not-ready: Item item-always-not-ready document or vault was not ready',
    })
    expect(mockPutSnapshots).not.toHaveBeenCalled()

    consoleErrorSpy.mockRestore()
    consoleWarnSpy.mockRestore()
  })

  it('records not-ready item in failureDetails and quarantines it if returned directly to processChunk', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setApiAuthToken('mock-token')

    const recoveryManager = { quarantine: vi.fn() } as any
    const reencryptor = new ItemReencryptor({
      ...context,
      keys,
      apiClient: { putSnapshots: vi.fn() } as any,
      recoveryManager,
    })
    vi.spyOn(reencryptor as any, 'buildSnapshotWithRetry').mockResolvedValueOnce({ type: 'not-ready' })

    const result = await reencryptor.processChunk(['item-unready' as any], {})

    expect(result.succeeded).toEqual([])
    expect(result.failed).toEqual([
      {
        itemId: 'item-unready',
        error: 'Failed to build snapshot for item item-unready: Document or vault was not ready after retries',
      },
    ])
    expect(recoveryManager.quarantine).toHaveBeenCalledWith(
      'item-unready',
      'snapshotFailure',
      'Re-encryption snapshot build failed: Failed to build snapshot for item item-unready: Document or vault was not ready after retries'
    )

    consoleErrorSpy.mockRestore()
    consoleWarnSpy.mockRestore()
  })

  it('logs error and continues gracefully if quarantining a failed item encounters a storage error', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setApiAuthToken('mock-token')
    mockListAutomergeItemIds.mockResolvedValue(['item-bad-storage'])
    vi.mocked(upsertManualRecoveryEntry).mockRejectedValueOnce(new Error('IndexedDB disk full'))

    mockRepo.find.mockImplementation(async () => {
      return {
        isReady: () => true,
        doc: () => null,
      }
    })

    const result = await itemReencryptor.reencryptAllItems()

    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].itemId).toBe('item-bad-storage')
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[reencryptAllItems] Failed to quarantine item item-bad-storage:',
      expect.any(Error)
    )

    consoleErrorSpy.mockRestore()
    consoleWarnSpy.mockRestore()
  })

  it('dynamically picks up a new auth token between batches', async () => {
    const items = Array.from({ length: 12 }, (_, i) => `item-${i}`)
    mockListAutomergeItemIds.mockResolvedValue(items)

    setApiAuthToken('token-1')
    const tokensSent: string[] = []
    mockPutSnapshots.mockImplementation(async () => {
      tokensSent.push(getApiAuthToken())
      // The main thread sends a new token while the first batch is in flight
      setApiAuthToken('token-2')
      return { success: true }
    })

    const result = await itemReencryptor.reencryptAllItems()

    expect(result.succeeded).toHaveLength(12)
    expect(mockPutSnapshots).toHaveBeenCalledTimes(2)
    expect(tokensSent).toEqual(['token-1', 'token-2'])
  })

  it('recovers from 401 auth error using refreshAuthToken and retries successfully', async () => {
    setApiAuthToken('old-token')
    mockListAutomergeItemIds.mockResolvedValue(['item-1', 'item-2'])

    const refreshAuthToken = vi.fn().mockImplementation(async () => {
      setApiAuthToken('refreshed-token')
      return 'refreshed-token'
    })
    const reencryptor = new ItemReencryptor({
      ...context,
      keys,
      apiClient: new SyncApiClient({ refreshAuthToken }),
    })

    const tokensSent: string[] = []
    mockPutSnapshots
      .mockImplementationOnce(async () => {
        tokensSent.push(getApiAuthToken())
        throw { data: { httpStatus: 401 }, message: 'UNAUTHORIZED' }
      })
      .mockImplementationOnce(async () => {
        tokensSent.push(getApiAuthToken())
        return { success: true }
      })

    const result = await reencryptor.reencryptAllItems()

    expect(refreshAuthToken).toHaveBeenCalledTimes(1)
    expect(mockPutSnapshots).toHaveBeenCalledTimes(2)
    expect(tokensSent).toEqual(['old-token', 'refreshed-token'])
    expect(result.succeeded).toEqual(['item-1', 'item-2'])
    expect(result.failed).toEqual([])
    expect(upsertManualRecoveryEntry).not.toHaveBeenCalled()
  })

  it('recovers from 401 auth error when a newer token has arrived', async () => {
    setApiAuthToken('stale-token')
    mockListAutomergeItemIds.mockResolvedValue(['item-1'])

    const tokensSent: string[] = []
    mockPutSnapshots
      .mockImplementationOnce(async () => {
        tokensSent.push(getApiAuthToken())
        setApiAuthToken('new-token')
        throw { data: { httpStatus: 401 } }
      })
      .mockImplementationOnce(async () => {
        tokensSent.push(getApiAuthToken())
        return { success: true }
      })

    const result = await itemReencryptor.reencryptAllItems()

    expect(mockPutSnapshots).toHaveBeenCalledTimes(2)
    expect(tokensSent).toEqual(['stale-token', 'new-token'])
    expect(result.succeeded).toEqual(['item-1'])
    expect(upsertManualRecoveryEntry).not.toHaveBeenCalled()
  })

  it('aborts immediately and DOES NOT quarantine items when auth error cannot be resolved', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const items = Array.from({ length: 20 }, (_, i) => `item-${i}`)
    mockListAutomergeItemIds.mockResolvedValue(items)
    setApiAuthToken('expired-token')

    mockPutSnapshots.mockRejectedValue({
      data: { httpStatus: 401 },
      message: 'UNAUTHORIZED',
    })

    await expect(itemReencryptor.reencryptAllItems()).rejects.toThrow(
      /session expired.*UNAUTHORIZED/i
    )

    // CRITICAL: Items must NOT be quarantined into manualRecoveryStore
    expect(upsertManualRecoveryEntry).not.toHaveBeenCalled()
    // CRITICAL: Subsequent batches must NOT be processed (only attempt 1 was made before aborting)
    expect(mockPutSnapshots).toHaveBeenCalledTimes(1)

    consoleWarnSpy.mockRestore()
  })

  it('gets a token via refreshAuthToken if the worker has none', async () => {
    setApiAuthToken('')
    const refreshAuthToken = vi.fn().mockImplementation(async () => {
      setApiAuthToken('recovered-token')
      return 'recovered-token'
    })
    mockListAutomergeItemIds.mockResolvedValue(['item-1'])
    const tokensSent: string[] = []
    mockPutSnapshots.mockImplementation(async () => {
      tokensSent.push(getApiAuthToken())
      return { success: true }
    })

    const reencryptor = new ItemReencryptor({
      ...context,
      keys,
      apiClient: new SyncApiClient({ refreshAuthToken }),
    })

    const result = await reencryptor.reencryptAllItems()

    expect(refreshAuthToken).toHaveBeenCalledTimes(1)
    expect(result.succeeded).toEqual(['item-1'])
    expect(tokensSent).toEqual(['recovered-token'])
  })

  describe('network failure during key rotation', () => {
    afterEach(() => {
      itemReencryptor.cancelScheduled()
    })

    it('aborts immediately and DOES NOT quarantine items when upload fails with a network error', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      setApiAuthToken('mock-token')
      // 20 items -> 2 batches of 10
      const items = Array.from({ length: 20 }, (_, i) => `item-${i}`)
      mockListAutomergeItemIds.mockResolvedValue(items)

      mockPutSnapshots.mockRejectedValue(new TypeError('Failed to fetch'))

      await expect(itemReencryptor.reencryptAllItems()).rejects.toThrow(
        /Re-encryption aborted: network error/
      )

      // CRITICAL: Items must NOT be quarantined into manualRecoveryStore
      expect(upsertManualRecoveryEntry).not.toHaveBeenCalled()
      // CRITICAL: Subsequent batches must NOT be processed (only batch 1 retried 3 times)
      expect(mockPutSnapshots).toHaveBeenCalledTimes(3)

      consoleWarnSpy.mockRestore()
    })

    it('aborts immediately and DOES NOT quarantine items when offline (navigator.onLine === false)', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      setApiAuthToken('mock-token')
      const items = Array.from({ length: 20 }, (_, i) => `item-${i}`)
      mockListAutomergeItemIds.mockResolvedValue(items)

      const originalNavigator = globalThis.navigator
      try {
        Object.defineProperty(globalThis, 'navigator', {
          value: { onLine: false },
          configurable: true,
          writable: true,
        })

        await expect(itemReencryptor.reencryptAllItems()).rejects.toThrow(
          /Re-encryption aborted: network error \(Network is offline\)/
        )

        // CRITICAL: No items quarantined, no upload attempts made while offline
        expect(upsertManualRecoveryEntry).not.toHaveBeenCalled()
        expect(mockPutSnapshots).not.toHaveBeenCalled()
      } finally {
        Object.defineProperty(globalThis, 'navigator', {
          value: originalNavigator,
          configurable: true,
          writable: true,
        })
        consoleWarnSpy.mockRestore()
      }
    })

    it('schedules a retry on a network error', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      setApiAuthToken('mock-token')
      mockListAutomergeItemIds.mockResolvedValue(['item-1'])
      mockPutSnapshots.mockRejectedValue(new Error('The network connection was lost.'))

      await expect(itemReencryptor.reencryptAllItems()).rejects.toThrow(
        /Re-encryption aborted: network error/
      )

      expect(itemReencryptor.isRetryScheduled).toBe(true)
      expect(itemReencryptor.retryAttempt).toBe(1)
      expect(upsertManualRecoveryEntry).not.toHaveBeenCalled()

      consoleWarnSpy.mockRestore()
    })

    it('distinguishes permanent upload failures from transient network errors', async () => {
      setApiAuthToken('mock-token')
      mockListAutomergeItemIds.mockResolvedValue(['item-perm-fail'])

      // Permanent failure (e.g. 400 Bad Request)
      mockPutSnapshots.mockRejectedValue({
        data: { httpStatus: 400 },
        message: 'Bad Request: Invalid snapshot schema',
      })

      const result = await itemReencryptor.reencryptAllItems()

      // Permanent failure: quarantined to manual recovery store and reported in failed
      expect(result.failed).toHaveLength(1)
      expect(result.failed[0].itemId).toBe('item-perm-fail')
      expect(upsertManualRecoveryEntry).toHaveBeenCalledWith('test-account', {
        itemId: 'item-perm-fail',
        kind: 'snapshotFailure',
        reason: expect.stringContaining('Re-encryption upload failed'),
      })
    })
  })

  describe('server outages during key rotation', () => {
    afterEach(() => {
      itemReencryptor.cancelScheduled()
    })

    it('aborts immediately and DOES NOT quarantine items when upload fails with HTTP 500 Internal Server Error', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      setApiAuthToken('mock-token')
      // 20 items -> 2 batches of 10
      const items = Array.from({ length: 20 }, (_, i) => `item-${i}`)
      mockListAutomergeItemIds.mockResolvedValue(items)

      mockPutSnapshots.mockRejectedValue({
        data: { httpStatus: 500, code: 'INTERNAL_SERVER_ERROR' },
        message: 'Internal server error',
      })

      await expect(itemReencryptor.reencryptAllItems()).rejects.toThrow(
        /Re-encryption aborted: server error/
      )

      // CRITICAL: Items must NOT be quarantined into manualRecoveryStore due to a transient server outage
      expect(upsertManualRecoveryEntry).not.toHaveBeenCalled()
      // CRITICAL: Subsequent batches must NOT be processed (only batch 1 retried 3 times)
      expect(mockPutSnapshots).toHaveBeenCalledTimes(3)

      consoleWarnSpy.mockRestore()
    })

    it('aborts and DOES NOT quarantine items on tRPC INTERNAL_SERVER_ERROR error code', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      setApiAuthToken('mock-token')
      mockListAutomergeItemIds.mockResolvedValue(['item-1'])

      mockPutSnapshots.mockRejectedValue({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Server error occurred while persisting snapshot',
      })

      await expect(itemReencryptor.reencryptAllItems()).rejects.toThrow(
        /Re-encryption aborted: server error/
      )

      expect(upsertManualRecoveryEntry).not.toHaveBeenCalled()
      expect(mockPutSnapshots).toHaveBeenCalledTimes(3)

      consoleWarnSpy.mockRestore()
    })

    it('aborts and DOES NOT quarantine items on 503 Service Unavailable', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      setApiAuthToken('mock-token')
      mockListAutomergeItemIds.mockResolvedValue(['item-1'])

      mockPutSnapshots.mockRejectedValue({
        status: 503,
        message: 'Service Unavailable',
      })

      await expect(itemReencryptor.reencryptAllItems()).rejects.toThrow(
        /Re-encryption aborted: server error/
      )

      expect(upsertManualRecoveryEntry).not.toHaveBeenCalled()

      consoleWarnSpy.mockRestore()
    })

    it('schedules a retry on a server error', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      setApiAuthToken('mock-token')
      mockListAutomergeItemIds.mockResolvedValue(['item-1'])
      mockPutSnapshots.mockRejectedValue({
        httpStatus: 500,
        message: 'Internal server error',
      })

      await expect(itemReencryptor.reencryptAllItems()).rejects.toThrow(
        /Re-encryption aborted: server error/
      )

      expect(itemReencryptor.isRetryScheduled).toBe(true)
      expect(itemReencryptor.retryAttempt).toBe(1)
      expect(upsertManualRecoveryEntry).not.toHaveBeenCalled()

      consoleWarnSpy.mockRestore()
    })

    it('splits ready snapshots into multiple upload batches when payload exceeds maxBatchBytes', async () => {
      setApiAuthToken('mock-token')
      mockListAutomergeItemIds.mockResolvedValue(['item-1', 'item-2', 'item-3'])
      mockPutSnapshots.mockResolvedValue({ success: true })

      // Each snapshot is ~150 bytes in mock (cipher 11 + iv 7 + id 6 + base 128 = 152 bytes)
      // Setting maxBatchBytes to 200 ensures each batch holds at most 1 item!
      const customReencryptor = new ItemReencryptor({
        ...context,
        keys,
        maxBatchBytes: 200,
      })

      const onProgress = vi.fn()
      const result = await customReencryptor.reencryptAllItems({ onProgress })

      expect(result).toEqual({
        succeeded: ['item-1', 'item-2', 'item-3'],
        failed: [],
      })
      // 3 items each exceeding maxBatchBytes when combined -> 3 upload calls instead of 1
      expect(mockPutSnapshots).toHaveBeenCalledTimes(3)
      expect(mockPutSnapshots.mock.calls[0][0].snapshots).toHaveLength(1)
      expect(mockPutSnapshots.mock.calls[1][0].snapshots).toHaveLength(1)
      expect(mockPutSnapshots.mock.calls[2][0].snapshots).toHaveLength(1)
    })

    it('handles failure of one size-partitioned batch while allowing another to succeed', async () => {
      setApiAuthToken('mock-token')
      mockListAutomergeItemIds.mockResolvedValue(['item-1', 'item-2'])

      // Batch 1 fails, Batch 2 succeeds
      mockPutSnapshots
        .mockResolvedValueOnce({ success: false })
        .mockResolvedValueOnce({ success: false })
        .mockResolvedValueOnce({ success: false })
        .mockResolvedValueOnce({ success: true })

      const customReencryptor = new ItemReencryptor({
        ...context,
        keys,
        maxBatchBytes: 200,
      })

      const result = await customReencryptor.reencryptAllItems()

      expect(result.succeeded).toEqual(['item-2'])
      expect(result.failed).toHaveLength(1)
      expect(result.failed[0].itemId).toBe('item-1')
      expect(upsertManualRecoveryEntry).toHaveBeenCalledWith('test-account', {
        itemId: 'item-1',
        kind: 'snapshotFailure',
        reason: expect.stringContaining('Re-encryption upload failed'),
      })
    })
  })
})

describe('ItemReencryptor class', () => {
  it('maintains independent retry state across instances', () => {
    const r1 = new ItemReencryptor(stageDeps({ retryDelays: [100, 200] }))
    const r2 = new ItemReencryptor(stageDeps({ retryDelays: [500, 1000] }))

    expect(r1.retryAttempt).toBe(0)
    expect(r2.retryAttempt).toBe(0)

    expect(r1.scheduleRetry()).toBe(100)
    expect(r1.retryAttempt).toBe(1)
    expect(r2.retryAttempt).toBe(0)

    expect(r2.scheduleRetry()).toBe(500)
    expect(r1.retryAttempt).toBe(1)
    expect(r2.retryAttempt).toBe(1)

    r1.cancelScheduled()
    expect(r1.retryAttempt).toBe(0)
    expect(r1.isRetryScheduled).toBe(false)
    expect(r2.retryAttempt).toBe(1)
    r2.cancelScheduled()
  })

  it('supports custom batchRetryDelays configuration', () => {
    const r = new ItemReencryptor(stageDeps({ batchRetryDelays: [50, 100] }))
    expect(r.batchRetryDelays).toEqual([50, 100])
  })

  describe('pipeline stages', () => {
    it('buildReencryptionPlan partitions item IDs into chunks', () => {
      const reencryptor = new ItemReencryptor(stageDeps())
      const itemIds = ['item-1', 'item-2', 'item-3', 'item-4', 'item-5']
      const plan = reencryptor.buildReencryptionPlan(itemIds as any, 2)
      expect(plan).toEqual([
        ['item-1', 'item-2'],
        ['item-3', 'item-4'],
        ['item-5'],
      ])
    })

    it('buildSnapshot is a pure operation building snapshot for an item', async () => {
      const reencryptor = new ItemReencryptor(stageDeps())
      const mockHandle = {
        isReady: vi.fn().mockReturnValue(true),
        doc: vi.fn().mockReturnValue({ id: 'item-1', type: 'note' }),
      }
      const mockRepo = {
        find: vi.fn().mockResolvedValue(mockHandle),
      }

      const result = await reencryptor.buildSnapshot('item-1' as any, mockRepo as any)
      expect(result.type).toBe('success')
      const typedResult = result as BuildSnapshotResult & { type: 'success' }
      expect(typedResult.snapshot.itemId).toBe('item-1')
    })

    it('uploadBatch is a pure operation that uploads snapshots and verifies confirmation', async () => {
      const reencryptor = new ItemReencryptor(stageDeps())
      const mockApiClient = {
        putSnapshots: vi.fn().mockResolvedValue({ success: true, persisted: 1, results: [{ itemId: 'item-1', version: 2 }] }),
      }

      const snapshots: any = [
        {
          itemId: 'item-1',
          snapshot: { cipher: 'c', iv: 'i', kver: '1' },
          snapshotCursor: 0,
          modified: 1000,
        },
      ]
      await expect(
        reencryptor.uploadBatch(mockApiClient as any, 'acc-1', snapshots.map((snapshot: any) => ({ snapshot })))
      ).resolves.toEqual([{ itemId: 'item-1', version: 2 }])
      expect(mockApiClient.putSnapshots).toHaveBeenCalledWith(
        { account: 'acc-1', snapshots },
        { signal: undefined }
      )
    })

    it('uploadBatch throws when unconfirmed or failed', async () => {
      const reencryptor = new ItemReencryptor(stageDeps())
      const mockApiClient = {
        putSnapshots: vi.fn().mockResolvedValue({ success: false }),
      }

      const snapshots: any = [
        {
          itemId: 'item-1',
          snapshot: { cipher: 'c', iv: 'i', kver: '1' },
          snapshotCursor: 0,
          modified: 1000,
        },
      ]
      await expect(
        reencryptor.uploadBatch(mockApiClient as any, 'acc-1', snapshots.map((snapshot: any) => ({ snapshot })))
      ).rejects.toThrow(/Upload unconfirmed/)
    })

    it('reportProgress clamps done to total and calls callback', () => {
      const reencryptor = new ItemReencryptor(stageDeps())
      const onProgress = vi.fn()
      reencryptor.reportProgress(15, 10, onProgress)
      expect(onProgress).toHaveBeenCalledWith(10, 10)
    })

    it('processChunk orchestrates building snapshots, uploading batch, and progress reporting', async () => {
      const mockHandle = {
        isReady: vi.fn().mockReturnValue(true),
        doc: vi.fn().mockReturnValue({ id: 'item-1', type: 'note' }),
      }
      const mockRepo = {
        find: vi.fn().mockResolvedValue(mockHandle),
      }
      const mockApiClient = {
        putSnapshots: vi.fn().mockResolvedValue({ success: true }),
      }
      const mockRecoveryManager = {
        quarantine: vi.fn().mockResolvedValue(undefined),
      }
      const onProgress = vi.fn()

      const reencryptor = new ItemReencryptor(stageDeps({
        accountId: 'test-acc',
        repo: mockRepo as any,
        apiClient: mockApiClient as any,
        recoveryManager: mockRecoveryManager as any,
      }))

      const result = await reencryptor.processChunk(['item-1' as any], { total: 1, processedCount: 0, onProgress })
      expect(result).toEqual({
        succeeded: ['item-1'],
        failed: [],
      })
      expect(mockApiClient.putSnapshots).toHaveBeenCalledTimes(1)
      expect(onProgress).toHaveBeenCalledWith(1, 1)
    })

    it('processChunk throws transient errors', async () => {
      const mockHandle = {
        isReady: vi.fn().mockReturnValue(true),
        doc: vi.fn().mockReturnValue({ id: 'item-1', type: 'note' }),
      }
      const mockRepo = {
        find: vi.fn().mockResolvedValue(mockHandle),
      }
      const mockApiClient = {
        putSnapshots: vi.fn().mockRejectedValue(new Error('The network connection was lost.')),
      }
      const mockRecoveryManager = {
        quarantine: vi.fn().mockResolvedValue(undefined),
      }

      const reencryptor = new ItemReencryptor(stageDeps({
        accountId: 'test-acc',
        repo: mockRepo as any,
        apiClient: mockApiClient as any,
        recoveryManager: mockRecoveryManager as any,
      }))

      await expect(reencryptor.processChunk(['item-1' as any], {})).rejects.toThrow(
        /Re-encryption aborted: network error/
      )
    })

    it('handleBatchUploadFailure classifies errors', () => {
      const reencryptor = new ItemReencryptor(stageDeps())
      // Network error throws
      expect(() =>
        reencryptor.handleBatchUploadFailure(new Error('network error'))
      ).toThrow(/Re-encryption aborted: network error/)

      // Permanent error returns string
      const msg = reencryptor.handleBatchUploadFailure(new Error('400 Bad Request'))
      expect(msg).toContain('Failed to upload snapshots for batch')
    })
  })
})

describe('reencryptAllItems cancellation and event loop yielding', () => {
  let mockRepo: any
  let mockHandle: any
  let itemReencryptor: ItemReencryptor
  let context: any

  beforeEach(() => {
    vi.clearAllMocks()
    setApiAuthToken('mock-token')
    mockListAutomergeItemIds.mockResolvedValue(['item-1', 'item-2'])

    mockHandle = {
      isReady: vi.fn().mockReturnValue(true),
      doc: vi.fn().mockReturnValue({ id: 'item-1', type: 'note' }),
    }

    mockRepo = {
      find: vi.fn().mockResolvedValue(mockHandle),
    }

    const mockIndexManager = {
      listAutomergeItemIds: () => mockListAutomergeItemIds(),
    }

    context = {
      accountId: 'test-account',
      repo: mockRepo,
      indexManager: mockIndexManager,
      apiClient: new SyncApiClient(),
      recoveryManager: new RecoveryManager({ accountId: 'test-account', eventHub: new ClientEventHub() }),
      codec: passthroughCodec,
    }
    itemReencryptor = new ItemReencryptor({ ...context, keys })
  })

  afterEach(() => {
    itemReencryptor.cancelScheduled()
  })

  it('aborts immediately and does NOT quarantine items when signal is pre-aborted', async () => {
    const controller = new AbortController()
    controller.abort(new Error('User cancelled'))

    await expect(
      itemReencryptor.reencryptAllItems({ signal: controller.signal })
    ).rejects.toThrow('User cancelled')

    expect(mockPutSnapshots).not.toHaveBeenCalled()
    expect(upsertManualRecoveryEntry).not.toHaveBeenCalled()
  })

  it('aborts during batch upload retry and does NOT quarantine items', async () => {
    const controller = new AbortController()

    mockPutSnapshots.mockImplementation(async () => {
      // Abort after first failed attempt
      controller.abort(new Error('Operation cancelled'))
      throw new Error('Upload failed')
    })

    await expect(
      itemReencryptor.reencryptAllItems({ signal: controller.signal })
    ).rejects.toThrow('Operation cancelled')

    expect(upsertManualRecoveryEntry).not.toHaveBeenCalled()
  })

  it('yields to the event loop macrotask queue during upload retries', async () => {
    let macrotaskRun = false
    setTimeout(() => {
      macrotaskRun = true
    }, 0)

    mockPutSnapshots
      .mockRejectedValueOnce(new Error('transient network glitch'))
      .mockImplementationOnce(async () => {
        expect(macrotaskRun).toBe(true)
        return { success: true }
      })

    const result = await itemReencryptor.reencryptAllItems()

    expect(result.succeeded).toEqual(['item-1', 'item-2'])
    expect(macrotaskRun).toBe(true)
  })
})

describe('concurrency and retry race safety (H11)', () => {
  let mockRepo: any
  let mockHandle: any
  let itemReencryptor: ItemReencryptor
  let context: any

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    setApiAuthToken('mock-token')
    mockListAutomergeItemIds.mockResolvedValue(['item-1', 'item-2'])

    mockHandle = {
      isReady: vi.fn().mockReturnValue(true),
      doc: vi.fn().mockReturnValue({ id: 'item-1', type: 'note' }),
    }

    mockRepo = {
      find: vi.fn().mockResolvedValue(mockHandle),
    }

    const mockIndexManager = {
      listAutomergeItemIds: () => mockListAutomergeItemIds(),
    }

    context = {
      accountId: 'test-account',
      repo: mockRepo,
      indexManager: mockIndexManager,
      apiClient: new SyncApiClient(),
      recoveryManager: new RecoveryManager({ accountId: 'test-account', eventHub: new ClientEventHub() }),
      codec: passthroughCodec,
    }
    itemReencryptor = new ItemReencryptor({ ...context, keys })
  })

  afterEach(() => {
    itemReencryptor.cancelScheduled()
    vi.useRealTimers()
  })

  it('coalesces concurrent reencryptAllItems calls using SingleFlightGuard', async () => {
    let resolveUpload: (val: any) => void
    const uploadPromise = new Promise(resolve => {
      resolveUpload = resolve
    })
    mockPutSnapshots.mockImplementation(() => uploadPromise)

    const onProgress1 = vi.fn()
    const onProgress2 = vi.fn()

    const p1 = itemReencryptor.reencryptAllItems({ onProgress: onProgress1 })
    expect(itemReencryptor.isReencrypting).toBe(true)

    const p2 = itemReencryptor.reencryptAllItems({ onProgress: onProgress2 })

    // Complete the upload
    resolveUpload!({ success: true })

    const [res1, res2] = await Promise.all([p1, p2])

    expect(res1).toEqual({ succeeded: ['item-1', 'item-2'], failed: [] })
    expect(res2).toEqual({ succeeded: ['item-1', 'item-2'], failed: [] })
    expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
    expect(onProgress1).toHaveBeenCalledWith(2, 2)
    expect(onProgress2).toHaveBeenCalledWith(2, 2)
    expect(itemReencryptor.isReencrypting).toBe(false)
  })

  it('coalesces a scheduled retry execution and a concurrent manual invocation without corrupting state', async () => {
    vi.useFakeTimers()
    let resolveUpload: (val: any) => void
    const uploadPromise = new Promise(resolve => {
      resolveUpload = resolve
    })
    mockPutSnapshots.mockImplementation(() => uploadPromise)

    const retryProgress = vi.fn()
    const manualProgress = vi.fn()

    // Schedule a retry
    itemReencryptor.scheduleRetry({ onProgress: retryProgress })

    // Advance timers so the scheduled retry fires its fireAndForget(reencryptAllItems)
    vi.runOnlyPendingTimers()

    expect(itemReencryptor.isReencrypting).toBe(true)

    // Now, manual invocation happens while the scheduled retry is executing in background
    const manualPromise = itemReencryptor.reencryptAllItems({ onProgress: manualProgress })

    // Complete the in-flight upload
    resolveUpload!({ success: true })

    const result = await manualPromise

    expect(result).toEqual({ succeeded: ['item-1', 'item-2'], failed: [] })
    expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
    expect(retryProgress).toHaveBeenCalledWith(2, 2)
    expect(manualProgress).toHaveBeenCalledWith(2, 2)
    expect(itemReencryptor.isReencrypting).toBe(false)
  })

  it('cancels pending scheduled retry timeout when reencryptAllItems is invoked manually', async () => {
    vi.useFakeTimers()
    mockPutSnapshots.mockResolvedValue({ success: true })

    const retryProgress = vi.fn()
    const manualProgress = vi.fn()

    // Schedule a retry
    itemReencryptor.scheduleRetry({ onProgress: retryProgress })

    // Invoke reencryptAllItems manually BEFORE the scheduled timer elapses
    const manualPromise = itemReencryptor.reencryptAllItems({ onProgress: manualProgress })

    const result = await manualPromise
    expect(result.succeeded).toEqual(['item-1', 'item-2'])
    expect(manualProgress).toHaveBeenCalledWith(2, 2)
    expect(mockPutSnapshots).toHaveBeenCalledTimes(1)

    // Advance time past the scheduled retry duration
    vi.advanceTimersByTime(100_000)

    // The scheduled retry should NOT have run because it was cancelled by manual invocation
    expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
    expect(retryProgress).not.toHaveBeenCalled()
  })

  it('does not store activeContext or activeProgressCallback on instance', () => {
    expect((itemReencryptor as any).activeContext).toBeUndefined()
    expect((itemReencryptor as any).activeProgressCallback).toBeUndefined()
  })

  it('allows a coalesced caller to abort independently without terminating the in-flight operation', async () => {
    let resolveUpload: (val: any) => void
    const uploadPromise = new Promise(resolve => {
      resolveUpload = resolve
    })
    mockPutSnapshots.mockImplementation(() => uploadPromise)

    const abortController = new AbortController()

    const p1 = itemReencryptor.reencryptAllItems()
    const p2 = itemReencryptor.reencryptAllItems({ signal: abortController.signal })

    // Abort caller 2 while caller 1 is still in flight
    abortController.abort(new Error('Caller 2 cancelled'))

    await expect(p2).rejects.toThrow('Caller 2 cancelled')

    // Caller 1 is still running
    expect(itemReencryptor.isReencrypting).toBe(true)

    // Complete the in-flight upload
    resolveUpload!({ success: true })

    const res1 = await p1
    expect(res1).toEqual({ succeeded: ['item-1', 'item-2'], failed: [] })
    expect(itemReencryptor.isReencrypting).toBe(false)
  })
})
