import { SnapshotPusher } from './SnapshotPusher'
import { SnapshotTracker } from './SnapshotTracker'
import { SNAPSHOT_DOC_LOOKUP_TIMEOUT_MS, SnapshotBuilder } from './snapshotBuilder'
import { ItemId, MAX_ITEM_SIZE_KB } from '@vault/shared'
import { AuthError } from './SyncApiClient'
import { createMockKeyProvider, createMockVault } from './__test__/testUtils'
import { spyOnExports } from '../../../test/moduleMocks'
import { passthroughCodec } from './domain'
import * as docStoreModule from './docStore'
import * as automergeModule from './utils/automerge'
import * as Automerge from '@automerge/automerge/slim'

describe('SnapshotPusher', () => {
  let pusher: SnapshotPusher
  let mockTracker: any
  let mockBuilder: any
  let mockBroker: any
  let mockApiClient: any
  let mockRecoveryManager: any
  let mockEventHub: any

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()

    mockTracker = {
      isOperational: true,
      dirtyCount: 1,
      getDirtyItemIds: vi.fn().mockReturnValue(['item-1' as ItemId]),
      getDirtyTick: vi.fn().mockReturnValue(1),
      recordSnapshotSuccess: vi.fn(),
      recordOversized: vi.fn(),
      removeDirtyItemIfTickMatches: vi.fn(),
      clearDebounceTimers: vi.fn(),
    }

    mockBuilder = {
      build: vi.fn().mockResolvedValue({
        type: 'success',
        snapshot: {
          itemId: 'item-1' as ItemId,
          snapshot: { cipher: 'abc', iv: '123', kver: '1' },
          snapshotCursor: 10,
          modified: 1000,
        },
        heads: ['head-1'],
      }),
      estimateSize: vi.fn().mockReturnValue(200),
    }

    mockBroker = {
      setSyncedHeads: vi.fn(),
      clearSnapshotOnlyItem: vi.fn(),
      unblockItem: vi.fn(),
    }

    mockApiClient = {
      putSnapshots: vi.fn().mockResolvedValue({
        success: true,
        persisted: 1,
        results: [{ itemId: 'item-1', version: 2 }],
      }),
    }

    mockRecoveryManager = {
      quarantine: vi.fn().mockResolvedValue(undefined),
      unquarantine: vi.fn().mockResolvedValue(undefined),
    }

    mockEventHub = {
      emit: vi.fn(),
    }

    pusher = new SnapshotPusher({
      accountId: 'test-acc',
      tracker: mockTracker as unknown as SnapshotTracker,
      builder: mockBuilder as unknown as SnapshotBuilder,
      broker: mockBroker,
      apiClient: mockApiClient,
      recoveryManager: mockRecoveryManager,
      eventHub: mockEventHub,
      maxPayloadBytes: 1000,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('pushes snapshots successfully and notifies tracker and broker', async () => {
    const result = await pusher.triggerSnapshotPush()

    expect(result).toEqual({ persisted: 1, total: 1 })
    expect(mockApiClient.putSnapshots).toHaveBeenCalledTimes(1)
    expect(mockTracker.recordSnapshotSuccess).toHaveBeenCalledWith('item-1', 1000, 1, 2)
    expect(mockBroker.setSyncedHeads).toHaveBeenCalledWith('item-1', ['head-1'])
    // Setting the heads clears snapshot-only and unblocks the item itself
    expect(mockBroker.clearSnapshotOnlyItem).not.toHaveBeenCalled()
    expect(mockBroker.unblockItem).not.toHaveBeenCalled()
    expect(mockRecoveryManager.unquarantine).toHaveBeenCalledWith('item-1')
  })

  it('handles oversized item by quarantining and emitting quotaExceeded', async () => {
    mockBuilder.estimateSize.mockReturnValue(5000) // Exceeds maxPayloadBytes = 1000

    const result = await pusher.triggerSnapshotPush()

    expect(result).toEqual({ persisted: 0, total: 0 })
    expect(pusher.oversizedItems.has('item-1' as ItemId)).toBe(true)
    expect(mockTracker.recordOversized).toHaveBeenCalledWith('item-1', 1000)
    expect(mockEventHub.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'quotaExceeded' }),
    )
    expect(mockRecoveryManager.quarantine).toHaveBeenCalledWith(
      'item-1',
      'oversized',
      expect.stringContaining(`exceeds ${MAX_ITEM_SIZE_KB} KB limit`),
    )
  })

  describe('deleted oversized items', () => {
    const deletedSnapshot = (itemId: string) => ({
      type: 'success',
      snapshot: {
        itemId: itemId as ItemId,
        snapshot: { cipher: 'abc', iv: '123', kver: '1' },
        snapshotCursor: 10,
        modified: 1000,
        deleted: true,
      },
      heads: ['head-1'],
    })

    beforeEach(() => {
      // Only snapshots carrying a cipher are over the limit
      mockBuilder.estimateSize.mockImplementation((s: any) => (s.snapshot ? 5000 : 200))
      mockBuilder.build.mockResolvedValue(deletedSnapshot('item-1'))
    })

    it('uploads a metadata-only tombstone for a deleted oversized item instead of quarantining', async () => {
      const result = await pusher.triggerSnapshotPush()

      expect(result).toEqual({ persisted: 1, total: 1 })
      const payload = mockApiClient.putSnapshots.mock.calls[0][0]
      expect(payload.snapshots).toHaveLength(1)
      expect(payload.snapshots[0]).toEqual({
        itemId: 'item-1',
        deleted: true,
        modified: 1000,
        snapshotCursor: 10,
      })
      expect('snapshot' in payload.snapshots[0]).toBe(false)
      expect(mockTracker.recordOversized).not.toHaveBeenCalled()
      expect(mockRecoveryManager.quarantine).not.toHaveBeenCalled()
      expect(mockEventHub.emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'quotaExceeded' }))
      expect(mockTracker.recordSnapshotSuccess).toHaveBeenCalledWith('item-1', 1000, 1, 2)
      expect(mockRecoveryManager.unquarantine).toHaveBeenCalledWith('item-1')
      expect(mockBroker.setSyncedHeads).not.toHaveBeenCalled()
      expect(pusher.oversizedItems.has('item-1' as ItemId)).toBe(false)
    })

    it('does not re-quarantine after the oversized flag was cleared by a recreation', async () => {
      pusher.addOversized('item-1' as ItemId)
      pusher.clearOversized('item-1' as ItemId)

      await pusher.triggerSnapshotPush()

      expect(mockApiClient.putSnapshots).toHaveBeenCalledTimes(1)
      expect(mockRecoveryManager.quarantine).not.toHaveBeenCalled()
      expect(mockTracker.recordOversized).not.toHaveBeenCalled()
    })

    it('batches a tombstone alongside normal snapshots and only records heads for the normal one', async () => {
      mockTracker.getDirtyItemIds.mockReturnValue(['item-1' as ItemId, 'item-2' as ItemId])
      mockBuilder.build.mockImplementation(async (itemId: string) => {
        if (itemId === 'item-1') return deletedSnapshot('item-1')
        return {
          type: 'success',
          snapshot: {
            itemId: 'item-2' as ItemId,
            snapshot: { cipher: 'def', iv: '456', kver: '1' },
            snapshotCursor: 10,
            modified: 2000,
          },
          heads: ['head-2'],
        }
      })
      mockBuilder.estimateSize.mockImplementation((s: any) => (s.deleted ? 200 : 300))
      // Make item-1's full snapshot look oversized only during preparation
      mockBuilder.estimateSize.mockImplementationOnce(() => 5000)
      mockApiClient.putSnapshots.mockResolvedValue({
        success: true,
        persisted: 2,
        results: [{ itemId: 'item-1', version: 3 }, { itemId: 'item-2', version: 4 }],
      })

      const result = await pusher.triggerSnapshotPush()

      expect(result).toEqual({ persisted: 2, total: 2 })
      expect(mockApiClient.putSnapshots).toHaveBeenCalledTimes(1)
      expect(mockApiClient.putSnapshots.mock.calls[0][0].snapshots).toHaveLength(2)
      expect(mockTracker.recordSnapshotSuccess).toHaveBeenCalledWith('item-1', 1000, 1, 3)
      expect(mockTracker.recordSnapshotSuccess).toHaveBeenCalledWith('item-2', 2000, 1, 4)
      expect(mockBroker.setSyncedHeads).toHaveBeenCalledTimes(1)
      expect(mockBroker.setSyncedHeads).toHaveBeenCalledWith('item-2', ['head-2'])
    })
  })

  it('quarantines item after 5 consecutive failures', async () => {
    mockBuilder.build.mockResolvedValue({
      type: 'error',
      reason: 'Failed to encrypt',
    })

    // 4 failures
    for (let i = 0; i < 4; i++) {
      await pusher.triggerSnapshotPush()
      expect(pusher.consecutiveFailures.get('item-1' as ItemId)).toBe(i + 1)
      expect(mockRecoveryManager.quarantine).not.toHaveBeenCalled()
    }

    // 5th failure triggers quarantine
    await pusher.triggerSnapshotPush()

    expect(pusher.consecutiveFailures.has('item-1' as ItemId)).toBe(false)
    expect(mockTracker.removeDirtyItemIfTickMatches).toHaveBeenCalledWith('item-1', 1)
    expect(mockEventHub.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'snapshotFailed', itemId: 'item-1' }),
    )
    expect(mockRecoveryManager.quarantine).toHaveBeenCalledWith(
      'item-1',
      'snapshotFailure',
      expect.stringContaining('Snapshot failure'),
    )
  })

  it('schedules retry on push failure when items remain dirty', async () => {
    mockApiClient.putSnapshots.mockResolvedValue({ success: false, persisted: 0, results: [] })

    await pusher.triggerSnapshotPush()

    expect(pusher.retryAttempt).toBe(1)
    expect(pusher.isRetryActive).toBe(true)

    // Cancel retry
    pusher.cancelRetry()
    expect(pusher.isRetryActive).toBe(false)
  })

  it('runs a follow-up push requested while a push was in flight', async () => {
    let releaseFirstPut!: () => void
    mockApiClient.putSnapshots.mockImplementationOnce(() => new Promise(resolve => {
      releaseFirstPut = () => resolve({ success: true, persisted: 1, results: [{ itemId: 'item-1', version: 2 }] })
    }))

    const firstPush = pusher.triggerSnapshotPush()
    await vi.waitFor(() => expect(mockApiClient.putSnapshots).toHaveBeenCalledTimes(1))
    const coalesced = pusher.triggerSnapshotPush()
    releaseFirstPut()
    await firstPush
    await coalesced

    await vi.waitFor(() => expect(mockApiClient.putSnapshots).toHaveBeenCalledTimes(2))
    expect(pusher.snapshotPushPending).toBe(false)
  })

  it('does not schedule a retry when a push is aborted', async () => {
    mockApiClient.putSnapshots.mockImplementationOnce(() => Promise.reject(new DOMException('Aborted', 'AbortError')))

    await pusher.triggerSnapshotPush()

    expect(pusher.isRetryActive).toBe(false)
  })

  describe('a document lookup that never settles', () => {
    let mockRepo: any
    let findSignals: Map<string, AbortSignal>

    beforeEach(() => {
      spyOnExports(Automerge, {
        save: () => new Uint8Array([1, 2, 3]),
        getHeads: () => ['head'],
      })
      spyOnExports(docStoreModule, {
        normalizeItemSnapshot: () => ({ type: 'topic' }),
      })
      spyOnExports(automergeModule, {
        toAutomergeUrlFromItemId: (itemId: string) => `automerge:${itemId}`,
      })

      findSignals = new Map()
      mockRepo = {
        // item-1's handle stays pending, like one whose local records fail to decrypt
        find: vi.fn((url: string, { signal }: { signal?: AbortSignal } = {}) => {
          if (signal) findSignals.set(url, signal)
          if (url !== 'automerge:item-1') {
            return Promise.resolve({ isReady: () => true, doc: () => ({ id: url }) })
          }
          return new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
          })
        }),
      }
      const keys = createMockKeyProvider({
        ...createMockVault(),
        encryptBytes: vi.fn().mockResolvedValue({ cipher: 'abc', iv: '123', kver: '1' }),
      })
      mockTracker.getDirtyItemIds.mockReturnValue(['item-1' as ItemId, 'item-2' as ItemId])
      mockApiClient.putSnapshots.mockResolvedValue({
        success: true,
        persisted: 1,
        results: [{ itemId: 'item-2', version: 2 }],
      })

      pusher = new SnapshotPusher({
        accountId: 'test-acc',
        tracker: mockTracker as unknown as SnapshotTracker,
        builder: new SnapshotBuilder(mockRepo, keys, passthroughCodec),
        broker: mockBroker,
        apiClient: mockApiClient,
        recoveryManager: mockRecoveryManager,
        eventHub: mockEventHub,
        maxPayloadBytes: 10_000,
      })
    })

    it('fails that item after the lookup timeout and still uploads the later items', async () => {
      let settled = false
      const push = pusher.triggerSnapshotPush().then(result => {
        settled = true
        return result
      })

      await vi.advanceTimersByTimeAsync(SNAPSHOT_DOC_LOOKUP_TIMEOUT_MS - 1)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)

      await expect(push).resolves.toEqual({ persisted: 1, total: 1 })
      expect(mockApiClient.putSnapshots).toHaveBeenCalledTimes(1)
      expect(mockApiClient.putSnapshots.mock.calls[0][0].snapshots.map((s: any) => s.itemId)).toEqual(['item-2'])
      expect(pusher.consecutiveFailures.get('item-1' as ItemId)).toBe(1)
      // A failed item leaves the push unsuccessful, so it's retried with backoff
      expect(pusher.isRetryActive).toBe(true)
    })

    it('quarantines the item once its lookups have timed out too many times', async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const push = pusher.triggerSnapshotPush()
        await vi.advanceTimersByTimeAsync(SNAPSHOT_DOC_LOOKUP_TIMEOUT_MS)
        await push
        pusher.cancelRetry()
      }

      expect(mockTracker.removeDirtyItemIfTickMatches).toHaveBeenCalledWith('item-1', 1)
      expect(mockRecoveryManager.quarantine).toHaveBeenCalledWith(
        'item-1',
        'snapshotFailure',
        expect.stringContaining('Document lookup timed out'),
      )
    })

    it('stops at once when the push is aborted, without counting a failure', async () => {
      const push = pusher.triggerSnapshotPush()
      await vi.waitFor(() => expect(findSignals.has('automerge:item-1')).toBe(true))

      pusher.abortPush()

      await expect(push).resolves.toEqual({ persisted: 0, total: 0 })
      expect(findSignals.get('automerge:item-1')?.aborted).toBe(true)
      expect(mockRepo.find).toHaveBeenCalledTimes(1)
      expect(mockApiClient.putSnapshots).not.toHaveBeenCalled()
      expect(pusher.consecutiveFailures.size).toBe(0)
      expect(mockRecoveryManager.quarantine).not.toHaveBeenCalled()
      expect(pusher.isRetryActive).toBe(false)
    })

    it('lets shutdown finish while the lookup is pending', async () => {
      const push = pusher.triggerSnapshotPush()
      await vi.waitFor(() => expect(mockRepo.find).toHaveBeenCalledWith('automerge:item-1', expect.anything()))

      await pusher.shutdown()

      await expect(push).resolves.toEqual({ persisted: 0, total: 0 })
      expect(vi.getTimerCount()).toBe(0)
    })
  })

  it('handles push gracefully if no auth token is present (AuthError)', async () => {
    mockApiClient.putSnapshots.mockRejectedValue(new AuthError('No active session token available'))

    const result = await pusher.triggerSnapshotPush()
    expect(result).toEqual({ persisted: 0, total: 0 })
    expect(mockApiClient.putSnapshots).toHaveBeenCalled()
  })
})
