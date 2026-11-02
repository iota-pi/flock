import { SnapshotPusher } from './SnapshotPusher'
import { SnapshotTracker } from './SnapshotTracker'
import { SnapshotBuilder } from './SnapshotBuilder'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'
import { SyncSessionState } from './SyncSessionState'
import { type ItemId, MAX_ITEM_SIZE_KB } from '@vault/shared'
import { AuthError, SyncApiClient } from './SyncApiClient'
import { RecoveryManager } from './RecoveryManager'
import { LastModifiedStore } from './stores/LastModifiedStore'
import { getApiAuthToken, setApiAuthToken } from '../keys/runtime'
import { fireAndForget } from '../utils/fireAndForget'
import { createMockKeyProvider, createMockVault, getTimestamps, spyOnVaultTrpc } from './__test__/testUtils'
import { spyOnExports } from '../../test/moduleMocks'
import { passthroughCodec } from './domain'
import * as manualRecoveryStoreModule from '../shared/manualRecoveryStore'
import * as docStoreModule from './docStore'
import * as automergeModule from './utils/automerge'
import * as Automerge from '@automerge/automerge/slim'

/** Estimates well above the pusher's `maxPayloadBytes` of 1000 */
const OVERSIZED_CIPHER = 'x'.repeat(5000)

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
      dirtyCount: 1,
      getDirtyItemIds: vi.fn().mockReturnValue(['item-1' as ItemId]),
      getDirtyTick: vi.fn().mockReturnValue(1),
      recordSnapshotSuccess: vi.fn(),
      recordOversized: vi.fn().mockReturnValue(true),
      clearOversized: vi.fn(),
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
    }

    mockBroker = {
      confirmSnapshot: vi.fn(),
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
      session: new SyncSessionState({ isLeader: true }),
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

  const oversizedSnapshot = () => ({
    type: 'success',
    snapshot: {
      itemId: 'item-1' as ItemId,
      snapshot: { cipher: OVERSIZED_CIPHER, iv: '123', kver: '1' },
      snapshotCursor: 10,
      modified: 1000,
    },
    heads: ['head-1'],
  })

  it('pushes snapshots successfully and notifies tracker and broker', async () => {
    const result = await pusher.triggerSnapshotPush()

    expect(result).toEqual({ persisted: 1, total: 1 })
    expect(mockApiClient.putSnapshots).toHaveBeenCalledTimes(1)
    expect(mockTracker.recordSnapshotSuccess).toHaveBeenCalledWith('item-1', 1000, 1, 2)
    expect(mockBroker.confirmSnapshot).toHaveBeenCalledWith('item-1', ['head-1'])
    expect(mockRecoveryManager.unquarantine).toHaveBeenCalledWith('item-1')
  })

  it('handles oversized item by quarantining and reporting a snapshot failure', async () => {
    mockBuilder.build.mockResolvedValue(oversizedSnapshot())

    const result = await pusher.triggerSnapshotPush()

    expect(result).toEqual({ persisted: 0, total: 0 })
    expect(mockTracker.recordOversized).toHaveBeenCalledWith('item-1', 1000)
    expect(mockEventHub.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'snapshotFailed', itemId: 'item-1' }),
    )
    expect(mockEventHub.emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'quotaExceeded' }))
    expect(mockRecoveryManager.quarantine).toHaveBeenCalledWith(
      'item-1',
      'oversized',
      expect.stringContaining(`exceeds ${MAX_ITEM_SIZE_KB} KB limit`),
    )
  })

  it('does not warn again about an item the tracker already knows is oversized', async () => {
    mockBuilder.build.mockResolvedValue(oversizedSnapshot())
    mockTracker.recordOversized.mockReturnValue(false)

    await pusher.triggerSnapshotPush()

    expect(mockTracker.recordOversized).toHaveBeenCalledWith('item-1', 1000)
    expect(mockEventHub.emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'snapshotFailed' }))
    expect(mockRecoveryManager.quarantine).not.toHaveBeenCalled()
  })

  describe('deleted oversized items', () => {
    const deletedSnapshot = (itemId: string) => ({
      type: 'success',
      snapshot: {
        itemId: itemId as ItemId,
        snapshot: { cipher: OVERSIZED_CIPHER, iv: '123', kver: '1' },
        snapshotCursor: 10,
        modified: 1000,
        deleted: true,
      },
      heads: ['head-1'],
    })

    beforeEach(() => {
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
      expect(mockBroker.confirmSnapshot).toHaveBeenCalledWith('item-1', undefined)
      expect(mockTracker.clearOversized).toHaveBeenCalledWith('item-1')
    })

    it('batches a tombstone alongside normal snapshots and confirms each, with heads only for the normal one', async () => {
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
      expect(mockBroker.confirmSnapshot).toHaveBeenCalledTimes(2)
      expect(mockBroker.confirmSnapshot).toHaveBeenCalledWith('item-1', undefined)
      expect(mockBroker.confirmSnapshot).toHaveBeenCalledWith('item-2', ['head-2'])
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
      expect(pusher['consecutiveFailures']['count']('item-1' as ItemId)).toBe(i + 1)
      expect(mockRecoveryManager.quarantine).not.toHaveBeenCalled()
    }

    // 5th failure triggers quarantine
    await pusher.triggerSnapshotPush()

    expect(pusher['consecutiveFailures']['count']('item-1' as ItemId)).toBe(0)
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
    expect(pusher['pendingPushRequested']).toBe(false)
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
        session: new SyncSessionState({ isLeader: true }),
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

      await vi.advanceTimersByTimeAsync(SYNC_TIMEOUTS.snapshotDocLookup - 1)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)

      await expect(push).resolves.toEqual({ persisted: 1, total: 1 })
      expect(mockApiClient.putSnapshots).toHaveBeenCalledTimes(1)
      expect(mockApiClient.putSnapshots.mock.calls[0][0].snapshots.map((s: any) => s.itemId)).toEqual(['item-2'])
      expect(pusher['consecutiveFailures']['count']('item-1' as ItemId)).toBe(1)
      // A failed item leaves the push unsuccessful, so it's retried with backoff
      expect(pusher.isRetryActive).toBe(true)
    })

    it('quarantines the item once its lookups have timed out too many times', async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const push = pusher.triggerSnapshotPush()
        await vi.advanceTimersByTimeAsync(SYNC_TIMEOUTS.snapshotDocLookup)
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
      expect(pusher['consecutiveFailures']['counts'].size).toBe(0)
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

  describe('with a real tracker and builder', () => {
    const mockPutSnapshots = vi.fn()
    const mockUpsertManualRecoveryEntry = vi.fn().mockResolvedValue(undefined)
    const mockRemoveManualRecoveryEntryByItemId = vi.fn().mockResolvedValue(undefined)
    const mockReadManualRecoveryEntries = vi.fn().mockResolvedValue([])
    const vault = {
      ...createMockVault(),
      encryptBytes: vi.fn().mockResolvedValue({
        iv: 'mock-iv',
        cipher: 'mock-cipher',
        kver: '1',
      }),
    }
    const keys = createMockKeyProvider(vault)

    let tracker: SnapshotTracker
    let session: SyncSessionState
    let mockRepo: any
    let mockHandle: any
    let lastModifiedStore: LastModifiedStore

    /**
     * The server always lists the stored items in `results`. A mocked response that leaves them out stores
     * the whole batch when it persisted every item and nothing otherwise.
     */
    async function withSnapshotResults(input: any, response: any) {
      const resolved = await response
      if (!resolved || resolved.results) {
        return resolved
      }
      const results = resolved.persisted === input.snapshots.length
        ? input.snapshots.map((s: any) => ({ itemId: s.itemId, version: 1 }))
        : []
      return { ...resolved, results }
    }

    /** Replaces `tracker` and `pusher` with a real tracker wired to a pusher, as SnapshotManager wires them */
    function createPusher(options: { maxPayloadBytes?: number } = {}): void {
      session = new SyncSessionState({ isLeader: true })
      tracker = new SnapshotTracker({
        lastModifiedStore,
        recoveryManager: mockRecoveryManager,
        session,
        onTriggerPush: () => fireAndForget(pusher.triggerSnapshotPush(), 'test:onTriggerPush'),
        isRetryActive: () => pusher.isRetryActive,
      })
      pusher = new SnapshotPusher({
        accountId: 'test-account',
        session,
        tracker,
        builder: new SnapshotBuilder(mockRepo, keys, passthroughCodec),
        broker: mockBroker,
        recoveryManager: mockRecoveryManager,
        apiClient: new SyncApiClient(),
        eventHub: mockEventHub,
        maxPayloadBytes: options.maxPayloadBytes,
      })
    }

    /** Simulates a worker restart: drops the in-memory state and replaces it with a fresh tracker and pusher */
    async function restart(): Promise<void> {
      session.markShutdown()
      await pusher.shutdown()
      await tracker.shutdown({ clearLocalData: true })
      createPusher()
    }

    beforeEach(async () => {
      spyOnVaultTrpc({
        putSnapshots: (...args: any[]) => withSnapshotResults(args[0], mockPutSnapshots(...args)),
      })
      spyOnExports(manualRecoveryStoreModule, {
        upsertManualRecoveryEntry: (...args: any[]) => mockUpsertManualRecoveryEntry(...args),
        removeManualRecoveryEntryByItemId: (...args: any[]) => mockRemoveManualRecoveryEntryByItemId(...args),
        readManualRecoveryEntries: (...args: any[]) => mockReadManualRecoveryEntries(...args),
      })
      spyOnExports(automergeModule, {
        toAutomergeUrlFromItemId: vi.fn((itemId: string) => `automerge:${itemId}`),
      })
      spyOnExports(Automerge, {
        save: vi.fn().mockReturnValue(new Uint8Array([1, 2, 3])),
        getHeads: vi.fn().mockReturnValue(['mock-head']),
      })
      vi.spyOn(docStoreModule, 'normalizeItemSnapshot').mockReturnValue({ type: 'note' } as any)

      // The store persists between tests, and saves merge into it
      await new LastModifiedStore('test-account').clear()
      setApiAuthToken('mock-auth-token')

      mockHandle = {
        isReady: vi.fn().mockReturnValue(true),
        doc: vi.fn().mockReturnValue({ id: 'item-1', type: 'note' }),
      }
      mockRepo = {
        find: vi.fn().mockResolvedValue(mockHandle),
      }
      mockRecoveryManager = new RecoveryManager({ accountId: 'test-account', eventHub: mockEventHub })
      lastModifiedStore = new LastModifiedStore('test-account')
      createPusher()
    })

    describe('retries', () => {
      it('successfully pushes snapshots', async () => {
        mockPutSnapshots.mockResolvedValue({
          success: true,
          persisted: 1,
        })

        tracker.markItemDirty('item-1' as ItemId)
        await pusher.flushPendingSnapshots()

        expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
        expect(pusher.retryAttempt).toBe(0)
      })

      it('updates lastSnapshotAt on successful snapshot push', async () => {
        mockPutSnapshots.mockResolvedValue({
          success: true,
          persisted: 1,
          total: 1,
        })

        tracker.markItemDirty('item-1' as ItemId)
        await pusher.flushPendingSnapshots()

        const lastSnapshotAt = getTimestamps(tracker, 'item-1').lastSnapshotAt
        expect(lastSnapshotAt).toBeDefined()
        expect(typeof lastSnapshotAt).toBe('number')
        expect(lastSnapshotAt).toBeGreaterThan(0)
      })

      it('immediately flushes pending snapshots on flushPendingSnapshots()', async () => {
        mockPutSnapshots.mockResolvedValue({
          success: true,
          persisted: 1,
        })

        tracker.markItemDirty('item-1' as ItemId)
        expect(mockPutSnapshots).not.toHaveBeenCalled()

        await pusher.flushPendingSnapshots()
        expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
      })

      it('schedules retry when buildSnapshot returns null (e.g. not ready)', async () => {
        mockHandle.isReady.mockReturnValue(false)

        tracker.markItemDirty('item-1' as ItemId)
        await pusher.flushPendingSnapshots()

        expect(mockPutSnapshots).not.toHaveBeenCalled()
        expect(tracker.getDirtyItemIds()).toContain('item-1' as ItemId)
        expect(pusher.retryAttempt).toBe(1)
        expect(pusher.isRetryActive).toBe(true)

        // When handle becomes ready on retry
        mockHandle.isReady.mockReturnValue(true)
        mockPutSnapshots.mockResolvedValue({
          success: true,
          persisted: 1,
        })

        await vi.advanceTimersByTimeAsync(2000)

        expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
        expect(tracker.getDirtyItemIds()).not.toContain('item-1' as ItemId)
        expect(pusher.retryAttempt).toBe(0)
      })

      it('schedules retry when some items succeed but another returns null', async () => {
        mockPutSnapshots.mockResolvedValue({
          success: true,
          persisted: 1,
        })

        // item-1 is ready, item-2 is not ready
        mockRepo.find.mockImplementation((url: string) => {
          if (url.includes('item-1')) {
            return Promise.resolve({
              isReady: () => true,
              doc: () => ({ id: 'item-1', type: 'note' }),
            })
          }
          return Promise.resolve({
            isReady: () => false,
            doc: () => null,
          })
        })

        tracker.markItemDirty('item-1' as ItemId)
        tracker.markItemDirty('item-2' as ItemId)
        await pusher.flushPendingSnapshots()

        expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
        expect(tracker.getDirtyItemIds()).not.toContain('item-1' as ItemId)
        expect(tracker.getDirtyItemIds()).toContain('item-2' as ItemId)
        expect(pusher.retryAttempt).toBe(1)
        expect(pusher.isRetryActive).toBe(true)
      })

      it('aggressively schedules retries with exponential backoff on failure', async () => {
        mockPutSnapshots.mockResolvedValue({
          success: false,
          persisted: 0,
        })

        tracker.markItemDirty('item-1' as ItemId)
        await pusher.flushPendingSnapshots()
        expect(mockPutSnapshots).toHaveBeenCalledTimes(1)

        // Attempt 1: Backoff delay = 2000ms
        expect(pusher.retryAttempt).toBe(1)
        expect(pusher.isRetryActive).toBe(true)

        // Advance 1999ms, should not have retried yet
        await vi.advanceTimersByTimeAsync(1999)
        expect(mockPutSnapshots).toHaveBeenCalledTimes(1)

        // Advance to 2000ms, triggers first retry (attempt 2)
        await vi.advanceTimersByTimeAsync(1)
        expect(mockPutSnapshots).toHaveBeenCalledTimes(2)
        expect(pusher.retryAttempt).toBe(2)

        // Attempt 2: Backoff delay = 5000ms
        await vi.advanceTimersByTimeAsync(4999)
        expect(mockPutSnapshots).toHaveBeenCalledTimes(2)

        await vi.advanceTimersByTimeAsync(1)
        expect(mockPutSnapshots).toHaveBeenCalledTimes(3)
        expect(pusher.retryAttempt).toBe(3)
      })

      it('stops early and retries if putSnapshots throws an exception', async () => {
        mockPutSnapshots.mockRejectedValue(new Error('Network disconnected'))

        tracker.markItemDirty('item-1' as ItemId)
        await pusher.flushPendingSnapshots()
        expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
        expect(pusher.retryAttempt).toBe(1)

        // Should trigger first retry at 2000ms
        await vi.advanceTimersByTimeAsync(2000)
        expect(mockPutSnapshots).toHaveBeenCalledTimes(2)
        expect(pusher.retryAttempt).toBe(2)
      })

      it('resets the retry attempt counter to 0 on a successful retry', async () => {
        // 1. Fail first push
        mockPutSnapshots.mockResolvedValueOnce({
          success: false,
          persisted: 0,
        })

        tracker.markItemDirty('item-1' as ItemId)
        await pusher.flushPendingSnapshots()
        expect(pusher.retryAttempt).toBe(1)

        // 2. Succeed on second attempt (retry)
        mockPutSnapshots.mockResolvedValueOnce({
          success: true,
          persisted: 1,
        })

        await vi.advanceTimersByTimeAsync(2000)

        expect(mockPutSnapshots).toHaveBeenCalledTimes(2)
        expect(pusher.retryAttempt).toBe(0)
        expect(pusher.isRetryActive).toBe(false)
      })

      it('retains dirty items and schedules retry when putSnapshots returns persisted: 0 even if success is true', async () => {
        mockPutSnapshots.mockResolvedValue({
          success: true,
          persisted: 0,
          total: 1,
        })

        tracker.markItemDirty('item-1' as ItemId)
        await pusher.flushPendingSnapshots()

        expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
        expect(tracker.getDirtyItemIds()).toContain('item-1' as ItemId)
        expect(pusher.retryAttempt).toBe(1)
        expect(pusher.isRetryActive).toBe(true)
      })

      it('retains dirty items and schedules retry when putSnapshots returns persisted less than batch length', async () => {
        mockPutSnapshots.mockResolvedValue({
          success: false,
          persisted: 1,
          total: 2,
        })

        tracker.markItemDirty('item-1' as ItemId)
        tracker.markItemDirty('item-2' as ItemId)
        await pusher.flushPendingSnapshots()

        expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
        expect(tracker.getDirtyItemIds()).toContain('item-1' as ItemId)
        expect(tracker.getDirtyItemIds()).toContain('item-2' as ItemId)
        expect(pusher.retryAttempt).toBe(1)
        expect(pusher.isRetryActive).toBe(true)
      })

      it('records the items a partly stored batch did persist, and retries only the rest', async () => {
        mockPutSnapshots.mockResolvedValue({
          success: false,
          persisted: 1,
          total: 2,
          results: [{ itemId: 'item-1', version: 7 }],
        })

        tracker.markItemDirty('item-1' as ItemId)
        tracker.markItemDirty('item-2' as ItemId)
        await pusher.flushPendingSnapshots()

        expect(tracker.getDirtyItemIds()).not.toContain('item-1' as ItemId)
        expect(tracker.exportItemVersions().get('item-1' as ItemId)?.baseVersion).toBe(7)
        expect(tracker.getDirtyItemIds()).toContain('item-2' as ItemId)
        expect(pusher['consecutiveFailures']['count']('item-2' as ItemId)).toBe(1)
        expect(pusher.isRetryActive).toBe(true)
      })

      it('quarantines an item the server keeps leaving out of its results', async () => {
        mockPutSnapshots.mockResolvedValue({
          success: false,
          persisted: 0,
          total: 1,
          results: [],
        })

        tracker.markItemDirty('item-2' as ItemId)
        for (let i = 0; i < 5; i += 1) {
          await pusher.flushPendingSnapshots()
        }

        expect(tracker.getDirtyItemIds()).not.toContain('item-2' as ItemId)
        expect(mockUpsertManualRecoveryEntry).toHaveBeenCalledWith(
          'test-account',
          expect.objectContaining({ itemId: 'item-2', kind: 'snapshotFailure' }),
        )
        expect(mockEventHub.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'snapshotFailed', itemId: 'item-2' }))
      })

      it('resets all retry properties on shutdown', async () => {
        mockPutSnapshots.mockResolvedValue({
          success: false,
          persisted: 0,
        })

        tracker.markItemDirty('item-1' as ItemId)
        await pusher.flushPendingSnapshots()
        expect(pusher.retryAttempt).toBe(1)
        expect(pusher.isRetryActive).toBe(true)

        await pusher.shutdown()

        expect(pusher.retryAttempt).toBe(0)
        expect(pusher.isRetryActive).toBe(false)
      })

      it('does not bypass retry backoff when debounce timer sets snapshotPushPending during an in-flight failing push', async () => {
        let rejectPush: (err: any) => void
        mockPutSnapshots.mockImplementation(
          () =>
            new Promise((_, reject) => {
              rejectPush = reject
            }),
        )

        tracker.markItemDirty('item-1' as ItemId, 5000)

        // Advance 5000ms so the first push starts
        await vi.advanceTimersByTimeAsync(5000)
        expect(mockPutSnapshots).toHaveBeenCalledTimes(1)

        // While push 1 is in-flight, mark item-2 dirty with a 1000ms debounce
        tracker.markItemDirty('item-2' as ItemId, 1000)

        // Advance 1000ms so the debounce timer fires while push 1 is still in-flight
        // This calls triggerSnapshotPush while activePushPromise is present, setting snapshotPushPending = true
        await vi.advanceTimersByTimeAsync(1000)
        expect(pusher['pendingPushRequested']).toBe(true)

        // Push 1 fails
        rejectPush!(new Error('Network disconnected'))
        await vi.advanceTimersByTimeAsync(0)

        // On failure, retry is scheduled with backoff (2000ms). Immediate push must NOT be triggered.
        expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
        expect(pusher.isRetryActive).toBe(true)
        expect(pusher.retryAttempt).toBe(1)
        expect(pusher['pendingPushRequested']).toBe(false)

        // Advance 1999ms: retry should not have fired yet
        await vi.advanceTimersByTimeAsync(1999)
        expect(mockPutSnapshots).toHaveBeenCalledTimes(1)

        // Now make retry push succeed
        mockPutSnapshots.mockResolvedValueOnce({
          success: true,
          persisted: 2,
        })

        // Advance 1ms to 2000ms: retry fires and pushes both dirty items
        await vi.advanceTimersByTimeAsync(1)
        expect(mockPutSnapshots).toHaveBeenCalledTimes(2)
        expect(tracker.getDirtyItemIds()).toHaveLength(0)
        expect(pusher.retryAttempt).toBe(0)
        expect(pusher.isRetryActive).toBe(false)
      })

      it('does not schedule debounced push while in retry backoff', async () => {
        mockPutSnapshots.mockResolvedValueOnce({
          success: false,
          persisted: 0,
        })

        tracker.markItemDirty('item-1' as ItemId)
        await pusher.flushPendingSnapshots()
        expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
        expect(pusher.isRetryActive).toBe(true)
        expect(pusher.retryAttempt).toBe(1)

        // While waiting for retry, an item is marked dirty with 500ms debounce, which mustn't start its own push
        tracker.markItemDirty('item-2' as ItemId, 500)

        // Advance 500ms: no push should have occurred
        await vi.advanceTimersByTimeAsync(500)
        expect(mockPutSnapshots).toHaveBeenCalledTimes(1)

        // Advance to 2000ms: retry runs and pushes both items
        mockPutSnapshots.mockResolvedValueOnce({
          success: true,
          persisted: 2,
        })

        await vi.advanceTimersByTimeAsync(1500)
        expect(mockPutSnapshots).toHaveBeenCalledTimes(2)
        expect(tracker.getDirtyItemIds()).toHaveLength(0)
        expect(pusher.isRetryActive).toBe(false)
      })
    })

    describe('Adaptive Size Batching', () => {
      it('splits batches when the count reaches 25', async () => {
        mockPutSnapshots.mockImplementation(async (input: any) => ({
          success: true,
          persisted: input.snapshots.length,
        }))

        // Mark 30 documents dirty
        for (let i = 1; i <= 30; i += 1) {
          tracker.markItemDirty(`item-${i}` as ItemId)
        }

        await pusher.flushPendingSnapshots()

        // Should have been split into two calls: first with 25, second with 5.
        expect(mockPutSnapshots).toHaveBeenCalledTimes(2)
        expect(mockPutSnapshots.mock.calls[0][0].snapshots).toHaveLength(25)
        expect(mockPutSnapshots.mock.calls[1][0].snapshots).toHaveLength(5)
      })

      it('splits batches when total estimated payload bytes exceed maxPayloadBytes', async () => {
        createPusher({ maxPayloadBytes: 200 })

        mockPutSnapshots.mockResolvedValue({
          success: true,
          persisted: 1,
        })

        tracker.markItemDirty('item-1' as ItemId)
        tracker.markItemDirty('item-2' as ItemId)
        await pusher.flushPendingSnapshots()

        // Since each mock snapshot is ~140 bytes, two snapshots (280 bytes) will exceed 200 bytes limit.
        // So they should be pushed in 2 calls.
        expect(mockPutSnapshots).toHaveBeenCalledTimes(2)
        expect(mockPutSnapshots.mock.calls[0][0].snapshots).toHaveLength(1)
        expect(mockPutSnapshots.mock.calls[1][0].snapshots).toHaveLength(1)
      })

      it('skips a single snapshot if it exceeds maxPayloadBytes', async () => {
        createPusher({ maxPayloadBytes: 10 })

        mockPutSnapshots.mockResolvedValue({
          success: true,
          persisted: 1,
        })

        tracker.markItemDirty('item-1' as ItemId)
        await pusher.flushPendingSnapshots()

        // Should not be pushed, and should be removed from dirtyItems to avoid retry loops
        expect(mockPutSnapshots).not.toHaveBeenCalled()
        expect(tracker.getDirtyItemIds()).not.toContain('item-1' as ItemId)
      })
    })

    describe('In-Flight Dirty Tracking', () => {
      it('preserves dirty status if item is re-dirtied while snapshot upload is in flight', async () => {
        let resolveUpload: (val: any) => void
        const uploadPromise = new Promise(resolve => {
          resolveUpload = resolve
        })

        mockPutSnapshots.mockImplementation(() => uploadPromise)

        tracker.markItemDirty('item-1' as ItemId, 0)

        // Start the snapshot push
        await vi.advanceTimersByTimeAsync(0)
        expect(mockPutSnapshots).toHaveBeenCalledTimes(1)

        // While upload is in flight, item-1 is modified again
        tracker.markItemDirty('item-1' as ItemId)

        // Complete the in-flight upload
        resolveUpload!({
          success: true,
          persisted: 1,
        })
        await vi.advanceTimersByTimeAsync(0)

        // item-1 should still be dirty because it was modified after batch preparation
        expect(tracker.getDirtyItemIds()).toContain('item-1' as ItemId)
      })

      it('clears dirty status if item was not modified during in flight upload', async () => {
        mockPutSnapshots.mockResolvedValue({
          success: true,
          persisted: 1,
        })

        tracker.markItemDirty('item-1' as ItemId)
        await pusher.flushPendingSnapshots()

        expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
        expect(tracker.getDirtyItemIds()).not.toContain('item-1' as ItemId)
      })

      it('clears dirty status when item is re-dirtied after push begins but before its snapshot is built', async () => {
        mockPutSnapshots.mockResolvedValue({
          success: true,
          persisted: 2,
        })

        tracker.markItemDirty('item-1' as ItemId)
        tracker.markItemDirty('item-2' as ItemId)

        // When repo.find is called for item-1, simulate user modifying item-2 before item-2's snapshot is built
        const originalFind = mockRepo.find
        mockRepo.find = vi.fn().mockImplementation((url: string) => {
          if (url.includes('item-1')) {
            tracker.markItemDirty('item-2' as ItemId)
          }
          return originalFind(url)
        })

        await pusher.flushPendingSnapshots()

        expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
        // Both item-1 and item-2 should be cleanly cleared because item-2 was built with the new tick
        expect(tracker.getDirtyItemIds()).not.toContain('item-1' as ItemId)
        expect(tracker.getDirtyItemIds()).not.toContain('item-2' as ItemId)
      })
    })

    describe('flushPendingSnapshots with In-Flight Pushes', () => {
      it('waits for in-flight snapshot push to complete before returning', async () => {
        let resolveUpload: (val: any) => void
        const uploadPromise = new Promise(resolve => {
          resolveUpload = resolve
        })
        mockPutSnapshots.mockImplementation(() => uploadPromise)

        tracker.markItemDirty('item-1' as ItemId, 0)

        // Start the snapshot push
        await vi.advanceTimersByTimeAsync(0)
        expect(mockPutSnapshots).toHaveBeenCalledTimes(1)

        let flushed = false
        const flushPromise = pusher.flushPendingSnapshots().then(res => {
          flushed = true
          return res
        })

        // Advance timers; flush should NOT have resolved yet because push is in flight
        await vi.advanceTimersByTimeAsync(0)
        expect(flushed).toBe(false)

        // Complete in-flight upload
        resolveUpload!({
          success: true,
          persisted: 1,
        })

        const result = await flushPromise
        expect(flushed).toBe(true)
        expect(result).toEqual({ persisted: 1, total: 1 })
        expect(tracker.getDirtyItemIds()).toHaveLength(0)
      })

      it('flushes newly dirtied items after waiting for in-flight push to complete', async () => {
        let resolveUpload1: (val: any) => void
        const uploadPromise1 = new Promise(resolve => {
          resolveUpload1 = resolve
        })
        let resolveUpload2: (val: any) => void
        const uploadPromise2 = new Promise(resolve => {
          resolveUpload2 = resolve
        })

        mockPutSnapshots
          .mockImplementationOnce(() => uploadPromise1)
          .mockImplementationOnce(() => uploadPromise2)

        tracker.markItemDirty('item-1' as ItemId, 0)
        await vi.advanceTimersByTimeAsync(0)
        expect(mockPutSnapshots).toHaveBeenCalledTimes(1)

        // While upload 1 is in-flight, mark item-2 dirty and call flushPendingSnapshots
        tracker.markItemDirty('item-2' as ItemId)
        let flushed = false
        const flushPromise = pusher.flushPendingSnapshots().then(res => {
          flushed = true
          return res
        })

        await vi.advanceTimersByTimeAsync(0)
        expect(flushed).toBe(false)

        // Resolve upload 1
        resolveUpload1!({ success: true, persisted: 1 })
        await vi.advanceTimersByTimeAsync(0)

        // Upload 2 should now be invoked for item-2
        expect(mockPutSnapshots).toHaveBeenCalledTimes(2)
        expect(flushed).toBe(false)

        // Resolve upload 2
        resolveUpload2!({ success: true, persisted: 1 })
        const result = await flushPromise

        expect(flushed).toBe(true)
        expect(result).toEqual({ persisted: 2, total: 2 })
        expect(tracker.getDirtyItemIds()).toHaveLength(0)
      })

      it('multiple concurrent callers of flushPendingSnapshots all wait for in-flight push', async () => {
        let resolveUpload: (val: any) => void
        const uploadPromise = new Promise(resolve => {
          resolveUpload = resolve
        })
        mockPutSnapshots.mockImplementation(() => uploadPromise)

        tracker.markItemDirty('item-1' as ItemId, 0)
        await vi.advanceTimersByTimeAsync(0)

        let flushed1 = false
        let flushed2 = false
        const p1 = pusher.flushPendingSnapshots().then(res => {
          flushed1 = true
          return res
        })
        const p2 = pusher.flushPendingSnapshots().then(res => {
          flushed2 = true
          return res
        })

        await vi.advanceTimersByTimeAsync(0)
        expect(flushed1).toBe(false)
        expect(flushed2).toBe(false)

        resolveUpload!({ success: true, persisted: 1 })
        const [res1, res2] = await Promise.all([p1, p2])

        expect(flushed1).toBe(true)
        expect(flushed2).toBe(true)
        expect(res1).toEqual({ persisted: 1, total: 1 })
        expect(res2).toEqual({ persisted: 1, total: 1 })
      })

      it('aborts flush and returns when in-flight push fails, avoiding infinite loops', async () => {
        let resolveUpload: (val: any) => void
        const uploadPromise = new Promise(resolve => {
          resolveUpload = resolve
        })
        mockPutSnapshots.mockImplementation(() => uploadPromise)

        tracker.markItemDirty('item-1' as ItemId, 0)
        await vi.advanceTimersByTimeAsync(0)

        const flushPromise = pusher.flushPendingSnapshots()

        // Fail the in-flight upload
        resolveUpload!({ success: false, persisted: 0 })

        const result = await flushPromise
        expect(result).toEqual({ persisted: 0, total: 1 })
        // Item remains dirty and retry is scheduled
        expect(tracker.getDirtyItemIds()).toContain('item-1' as ItemId)
        expect(pusher.isRetryActive).toBe(true)
      })

      it('shutdown awaits in-flight push if one is running', async () => {
        let resolveUpload: (val: any) => void
        const uploadPromise = new Promise(resolve => {
          resolveUpload = resolve
        })
        mockPutSnapshots.mockImplementation(() => uploadPromise)

        tracker.markItemDirty('item-1' as ItemId, 0)
        await vi.advanceTimersByTimeAsync(0)

        let shutdownFinished = false
        session.markShutdown()
        const shutdownPromise = pusher.shutdown().then(() => {
          shutdownFinished = true
        })

        await vi.advanceTimersByTimeAsync(0)
        expect(shutdownFinished).toBe(false)

        resolveUpload!({ success: true, persisted: 1 })
        await shutdownPromise

        expect(shutdownFinished).toBe(true)
      })
    })

    describe('Not-Ready vs Error Build Failure Handling', () => {
      it('does not increment consecutiveBuildFailures or drop item when handle is not ready', async () => {
        mockHandle.isReady.mockReturnValue(false)

        tracker.markItemDirty('item-1' as ItemId)

        // Run 6 push attempts
        for (let i = 0; i < 6; i += 1) {
          await pusher.flushPendingSnapshots()
        }

        // Should still be dirty and failures map should not have counted failures
        expect(tracker.getDirtyItemIds()).toContain('item-1' as ItemId)
        expect(pusher['consecutiveFailures']['count']('item-1' as ItemId)).toBe(0)
      })

      it('increments consecutiveBuildFailures and moves item to manual recovery with user notification after MAX_CONSECUTIVE_SNAPSHOT_FAILURES on real error', async () => {
        mockHandle.doc.mockReturnValue(undefined) // Triggers error in buildSnapshot
        mockReadManualRecoveryEntries.mockResolvedValueOnce([
          { id: 'item-1', itemId: 'item-1', reason: 'Snapshot failure: Document data not available', createdAt: Date.now() },
        ])

        tracker.markItemDirty('item-1' as ItemId)

        // Run 5 attempts to reach MAX_CONSECUTIVE_SNAPSHOT_FAILURES (5)
        for (let i = 1; i <= 5; i += 1) {
          await pusher.flushPendingSnapshots()
        }

        // Item should now be dropped from active dirty queue
        expect(tracker.getDirtyItemIds()).not.toContain('item-1' as ItemId)
        expect(pusher['consecutiveFailures']['count']('item-1' as ItemId)).toBe(0)

        // User notification emitted via eventHub
        expect(mockEventHub.emit).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'snapshotFailed',
            itemId: 'item-1',
            message: expect.stringContaining('Snapshot sync failed for item item-1'),
          }),
        )

        // Persisted to manual recovery store
        expect(mockUpsertManualRecoveryEntry).toHaveBeenCalledWith(
          'test-account',
          expect.objectContaining({
            itemId: 'item-1',
            reason: expect.stringContaining('Snapshot failure:'),
          }),
        )

        // Recovery items changed event emitted to update UI
        expect(mockEventHub.emit).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'recoveryItemsChanged',
          }),
        )
      })

      it('does not increment failures or drop items on transient vault errors (e.g. Vault is locked)', async () => {
        const { encryptBytes } = vault
        vi.mocked(encryptBytes).mockRejectedValueOnce(new Error('Vault is locked'))

        tracker.markItemDirty('item-1' as ItemId)

        // Run 6 push attempts while vault is locked
        for (let i = 0; i < 6; i += 1) {
          vi.mocked(encryptBytes).mockRejectedValueOnce(new Error('Vault is locked'))
          await pusher.flushPendingSnapshots()
        }

        // Item must remain dirty and NOT be dropped
        expect(tracker.getDirtyItemIds()).toContain('item-1' as ItemId)
        expect(pusher['consecutiveFailures']['count']('item-1' as ItemId)).toBe(0)
        expect(mockEventHub.emit).not.toHaveBeenCalledWith(
          expect.objectContaining({ type: 'snapshotFailed' }),
        )
        expect(mockUpsertManualRecoveryEntry).not.toHaveBeenCalled()
      })

      it('does not drop items or count failures when batch network send fails', async () => {
        mockPutSnapshots.mockRejectedValue(new Error('Network disconnected'))

        tracker.markItemDirty('item-1' as ItemId)
        tracker.markItemDirty('item-2' as ItemId)

        // Run 6 push attempts where network fails
        for (let i = 0; i < 6; i += 1) {
          await pusher.flushPendingSnapshots()
        }

        // Items must remain dirty for subsequent retry and NOT be dropped
        expect(tracker.getDirtyItemIds()).toContain('item-1' as ItemId)
        expect(tracker.getDirtyItemIds()).toContain('item-2' as ItemId)
        expect(pusher['consecutiveFailures']['count']('item-1' as ItemId)).toBe(0)
        expect(pusher['consecutiveFailures']['count']('item-2' as ItemId)).toBe(0)
        expect(mockEventHub.emit).not.toHaveBeenCalledWith(
          expect.objectContaining({ type: 'snapshotFailed' }),
        )
      })

      it('clears manual recovery entry when snapshot upload subsequently succeeds', async () => {
        mockPutSnapshots.mockResolvedValue({
          success: true,
          persisted: 1,
        })

        tracker.markItemDirty('item-1' as ItemId)
        await pusher.flushPendingSnapshots()

        expect(mockRemoveManualRecoveryEntryByItemId).toHaveBeenCalledWith('test-account', 'item-1')
      })
    })

    describe('Oversized Snapshots', () => {
      it('notifies client eventHub and records to manualRecoveryStore without silent abandonment', async () => {
        // Very small limit so snapshot exceeds it
        createPusher({ maxPayloadBytes: 10 })

        tracker.markItemDirty('item-1' as ItemId)
        await pusher.flushPendingSnapshots()

        expect(mockPutSnapshots).not.toHaveBeenCalled()
        expect(mockEventHub.emit).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'snapshotFailed',
            itemId: 'item-1',
            message: expect.stringContaining(`exceeds the ${MAX_ITEM_SIZE_KB} KB limit`),
          }),
        )
        expect(mockUpsertManualRecoveryEntry).toHaveBeenCalledWith(
          'test-account',
          expect.objectContaining({
            itemId: 'item-1',
            reason: expect.stringContaining(`exceeds ${MAX_ITEM_SIZE_KB} KB limit`),
          }),
        )
      })

      it('suppresses repeated error logs and repeated manual recovery upserts on subsequent pushes for the same oversized item', async () => {
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        createPusher({ maxPayloadBytes: 10 })

        tracker.markItemDirty('item-1' as ItemId)
        await pusher.flushPendingSnapshots()

        // First attempt logs error and upserts manual recovery
        const firstErrorCallCount = consoleErrorSpy.mock.calls.filter(c => String(c[0]).includes('exceeds maxPayloadBytes')).length
        expect(firstErrorCallCount).toBe(1)
        expect(mockUpsertManualRecoveryEntry).toHaveBeenCalledTimes(1)

        // Re-mark dirty (e.g. from WAL re-negotiation or local change)
        tracker.markItemDirty('item-1' as ItemId)
        await pusher.flushPendingSnapshots()

        // Should NOT log error again or re-upsert manual recovery
        const secondErrorCallCount = consoleErrorSpy.mock.calls.filter(c => String(c[0]).includes('exceeds maxPayloadBytes')).length
        expect(secondErrorCallCount).toBe(1)
        expect(mockUpsertManualRecoveryEntry).toHaveBeenCalledTimes(1)

        consoleErrorSpy.mockRestore()
      })

      it('does not treat batch as failed or trigger retry loops when an oversized item is skipped alongside normal items', async () => {
        const { encryptBytes } = vault
        mockPutSnapshots.mockResolvedValue({
          success: true,
          persisted: 1,
        })

        // item-1 oversized (> 200 bytes), item-2 normal (< 200 bytes)
        vi.mocked(encryptBytes)
          .mockResolvedValueOnce({
            iv: 'mock-iv',
            cipher: 'large-cipher-payload-'.repeat(20),
            kver: '1',
          })
          .mockResolvedValueOnce({
            iv: 'mock-iv',
            cipher: 'small-cipher',
            kver: '1',
          })

        createPusher({ maxPayloadBytes: 200 })

        tracker.markItemDirty('item-1' as ItemId)
        tracker.markItemDirty('item-2' as ItemId)

        await pusher.flushPendingSnapshots()

        // Only item-2 pushed
        expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
        expect(mockPutSnapshots.mock.calls[0][0].snapshots[0].itemId).toBe('item-2')
        expect(tracker.getDirtyItemIds()).toHaveLength(0)
        expect(pusher.isRetryActive).toBe(false)
        expect(pusher.retryAttempt).toBe(0)
      })

      it('allows previously oversized item to sync once compacted below maxPayloadBytes', async () => {
        const { encryptBytes } = vault
        mockPutSnapshots.mockResolvedValue({
          success: true,
          persisted: 1,
        })

        createPusher({ maxPayloadBytes: 200 })

        // Step 1: Oversized item fails snapshot (> 200 bytes)
        vi.mocked(encryptBytes).mockResolvedValueOnce({
          iv: 'mock-iv',
          cipher: 'large-cipher-payload-'.repeat(20),
          kver: '1',
        })

        tracker.markItemDirty('item-1' as ItemId)
        await pusher.flushPendingSnapshots()

        expect(mockPutSnapshots).not.toHaveBeenCalled()
        expect(tracker['oversizedItems'].has('item-1' as ItemId)).toBe(true)

        // Step 2: Compaction occurs -> encrypted payload is now small (< 200 bytes)
        vi.mocked(encryptBytes).mockResolvedValueOnce({
          iv: 'mock-iv',
          cipher: 'small-cipher',
          kver: '1',
        })

        // Step 3: Marked dirty after compaction
        tracker.markItemDirty('item-1' as ItemId)
        await pusher.flushPendingSnapshots()

        // Now successfully pushed and cleared from oversizedItems
        expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
        expect(mockPutSnapshots.mock.calls[0][0].snapshots[0].itemId).toBe('item-1')
        expect(tracker['oversizedItems'].has('item-1' as ItemId)).toBe(false)
        expect(tracker.getDirtyItemIds()).not.toContain('item-1' as ItemId)
      })
    })

    describe('Missing Auth Token Handling', () => {
      it('schedules retry when there is no session token and dirty items exist', async () => {
        setApiAuthToken('')

        tracker.markItemDirty('item-1' as ItemId)
        const result = await pusher.flushPendingSnapshots()

        expect(result).toEqual({ persisted: 0, total: 0 })
        expect(mockPutSnapshots).not.toHaveBeenCalled()
        expect(tracker.getDirtyItemIds()).toContain('item-1' as ItemId)
        expect(pusher.retryAttempt).toBe(1)
        expect(pusher.isRetryActive).toBe(true)
        expect(pusher['consecutiveFailures']['count']('item-1' as ItemId)).toBe(0)
      })

      it('recovers and pushes snapshots when auth token becomes available on retry', async () => {
        setApiAuthToken('')
        const tokensSent: string[] = []
        mockPutSnapshots.mockImplementation(async () => {
          tokensSent.push(getApiAuthToken())
          return { success: true, persisted: 1 }
        })

        tracker.markItemDirty('item-1' as ItemId)
        await pusher.flushPendingSnapshots()

        expect(tracker.getDirtyItemIds()).toContain('item-1' as ItemId)
        expect(pusher.retryAttempt).toBe(1)
        expect(mockPutSnapshots).not.toHaveBeenCalled()

        // Restore auth token and advance to the first retry interval (2000ms)
        setApiAuthToken('restored-auth-token')
        await vi.advanceTimersByTimeAsync(2000)

        expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
        expect(tokensSent).toEqual(['restored-auth-token'])
        expect(tracker.getDirtyItemIds()).not.toContain('item-1' as ItemId)
        expect(pusher.retryAttempt).toBe(0)
      })

      it('does not schedule retry or treat as failure when dirtyItems is empty', async () => {
        setApiAuthToken('')

        const result = await pusher.flushPendingSnapshots()

        expect(result).toEqual({ persisted: 0, total: 0 })
        expect(mockPutSnapshots).not.toHaveBeenCalled()
        expect(pusher.isRetryActive).toBe(false)
        expect(pusher.retryAttempt).toBe(0)
      })

      it('does not increment consecutiveFailures or move items to manual recovery when auth token is missing repeatedly', async () => {
        setApiAuthToken('')

        tracker.markItemDirty('item-1' as ItemId)
        await pusher.flushPendingSnapshots()

        // Progress through retries: 2s, 5s, 10s, 30s, 60s
        await vi.advanceTimersByTimeAsync(2000)
        await vi.advanceTimersByTimeAsync(5000)
        await vi.advanceTimersByTimeAsync(10000)
        await vi.advanceTimersByTimeAsync(30000)
        await vi.advanceTimersByTimeAsync(60000)

        expect(pusher.retryAttempt).toBe(6)
        expect(tracker.getDirtyItemIds()).toContain('item-1' as ItemId)
        expect(pusher['consecutiveFailures']['count']('item-1' as ItemId)).toBe(0)
        expect(mockUpsertManualRecoveryEntry).not.toHaveBeenCalled()
      })
    })

    describe('Snapshot Push Timestamp Parity (H4 fix)', () => {
      it('advances localModifiedAt to match snapshot.modified on successful push', async () => {
        vi.setSystemTime(1000)
        tracker.markItemDirty('item-1' as ItemId)
        await vi.advanceTimersByTimeAsync(1000)

        expect(getTimestamps(tracker, 'item-1').localModifiedAt).toBe(1000)
        expect(getTimestamps(tracker, 'item-1').lastSnapshotAt).toBeUndefined()

        mockPutSnapshots.mockResolvedValue({
          success: true,
          persisted: 1,
        })

        // The debounced push runs at 31000
        await vi.advanceTimersByTimeAsync(29_000)

        expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
        const pushedSnapshot = mockPutSnapshots.mock.calls[0][0].snapshots[0]
        expect(pushedSnapshot.modified).toBe(31000)

        // Both timestamps must be in parity with the pushed snapshot
        expect(getTimestamps(tracker, 'item-1').lastSnapshotAt).toBe(31000)
        expect(getTimestamps(tracker, 'item-1').localModifiedAt).toBe(31000)

        // exportLastModified must export 31000 so ManifestSyncManager matches serverTime
        expect(tracker.exportLastModified()).toEqual([['item-1', 31000]])
      })

      it('preserves newer localModifiedAt if modified again while upload is in flight', async () => {
        vi.setSystemTime(1000)
        tracker.markItemDirty('item-1' as ItemId)
        await vi.advanceTimersByTimeAsync(1000)

        let resolveUpload: (val: any) => void
        const uploadPromise = new Promise(resolve => {
          resolveUpload = resolve
        })
        mockPutSnapshots.mockImplementation(() => uploadPromise)

        // The debounced push starts at 31000
        await vi.advanceTimersByTimeAsync(29_000)

        expect(mockPutSnapshots).toHaveBeenCalledTimes(1)

        // While upload is in flight, user modifies item-1 again at 32000
        vi.setSystemTime(32000)
        tracker.markItemDirty('item-1' as ItemId)
        await vi.advanceTimersByTimeAsync(1000)
        expect(getTimestamps(tracker, 'item-1').localModifiedAt).toBe(32000)

        // Upload completes for the snapshot built at 31000
        resolveUpload!({
          success: true,
          persisted: 1,
        })
        await vi.advanceTimersByTimeAsync(0)

        // lastSnapshotAt is 31000, but localModifiedAt must retain 32000
        expect(getTimestamps(tracker, 'item-1').lastSnapshotAt).toBe(31000)
        expect(getTimestamps(tracker, 'item-1').localModifiedAt).toBe(32000)
        expect(tracker.getDirtyItemIds()).toContain('item-1')
        expect(tracker.exportLastModified()).toEqual([['item-1', 32000]])
      })

      it('retains newer localModifiedAt and re-enqueues item if a local edit occurs during snapshot encryption (C3 fix)', async () => {
        vi.setSystemTime(1000)
        tracker.markItemDirty('item-1' as ItemId)
        await vi.advanceTimersByTimeAsync(1000)

        const { encryptBytes } = vault
        vi.mocked(encryptBytes).mockImplementationOnce(async () => {
          // Local edit arrives at T2 (32000) while encryption is in-flight
          vi.setSystemTime(32000)
          tracker.markItemDirty('item-1' as ItemId)
          // Encryption completes at T3 (33000)
          vi.setSystemTime(33000)
          return { iv: 'mock-iv', cipher: 'mock-cipher', kver: '1' }
        })

        mockPutSnapshots.mockResolvedValueOnce({
          success: true,
          persisted: 1,
        })

        // The debounced push starts at T1 (31000)
        await vi.advanceTimersByTimeAsync(29_000)

        // Snapshot timestamp was captured at T1, so lastSnapshotAt must be 31000
        expect(getTimestamps(tracker, 'item-1').lastSnapshotAt).toBe(31000)
        // The edit made during encryption keeps the item dirty
        expect(tracker.getDirtyItemIds()).toContain('item-1')

        // Debounced flush records the edit as newer than the uploaded snapshot
        await vi.advanceTimersByTimeAsync(1000)
        expect(getTimestamps(tracker, 'item-1').localModifiedAt).toBeGreaterThan(31000)

        // Persist timestamps and simulate restart / promotion audit
        await tracker.saveLastModified()
        await restart()
        expect(tracker.getDirtyItemIds()).not.toContain('item-1')

        await tracker.loadLastModified()
        // Startup audit should detect localMod > lastSnap (31000) and re-enqueue item-1
        expect(tracker.getDirtyItemIds()).toContain('item-1')
      })
    })
  })
})
