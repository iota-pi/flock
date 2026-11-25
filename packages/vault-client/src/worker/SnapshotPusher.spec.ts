import { SnapshotPusher } from './SnapshotPusher'
import { SnapshotSchedule } from './SnapshotSchedule'
import { ItemSyncState } from './ItemSyncState'
import { SnapshotBuilder } from './SnapshotBuilder'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'
import { SyncSessionState } from './SyncSessionState'
import { type ItemId, MAX_ITEM_SIZE_KB } from '@vault/shared'
import { AuthError, SyncApiClient } from './SyncApiClient'
import { RecoveryManager } from './RecoveryManager'
import { getApiAuthToken, setApiAuthToken } from '../keys/runtime'
import { createMemoryItemRecords, createMockKeyProvider, createMockVault, noLogCoverage, spyOnVaultTrpc } from './__test__/testUtils'
import { spyOnExports } from '../../test/moduleMocks'
import { passthroughCodec } from './domain'
import * as manualRecoveryStoreModule from '../shared/manualRecoveryStore'
import * as docStoreModule from './docStore'
import * as automergeModule from './utils/automerge'
import * as Automerge from '@automerge/automerge/slim'

/** Estimates well above the pusher's `maxPayloadBytes` of 1000 */
const OVERSIZED_CIPHER = 'x'.repeat(5000)

const quotaError = () => Object.assign(new Error('QUOTA_EXCEEDED'), {
  data: { code: 'TOO_MANY_REQUESTS', httpStatus: 429 },
})

describe('SnapshotPusher', () => {
  let pusher: SnapshotPusher
  let mockTracker: any
  let mockBuilder: any
  let mockPushToLog: any
  let mockOnSnapshotStored: any
  let mockApiClient: any
  let mockRecoveryManager: any
  let mockEventHub: any

  /** Expects the stored snapshot to have cleared the item at its tick and raised its base version */
  const expectStored = (itemId: string, tick: number, version: number) => {
    expect(mockTracker.clearDirty).toHaveBeenCalledWith(itemId, tick)
    expect(mockTracker.raiseBaseVersion).toHaveBeenCalledWith(itemId, version)
  }

  /** Runs the poll's snapshot phase */
  const push = (signal: AbortSignal = new AbortController().signal) => pusher.pushDue(signal)

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()

    mockTracker = {
      dirtyCount: 1,
      isDue: vi.fn().mockReturnValue(true),
      clearDue: vi.fn(),
      retryNextPoll: vi.fn(),
      deferUntil: vi.fn(),
      listDirty: vi.fn().mockReturnValue(['item-1' as ItemId]),
      getDirtyTick: vi.fn().mockReturnValue(1),
      clearDirty: vi.fn().mockReturnValue(true),
      raiseBaseVersion: vi.fn(),
      flushPendingSave: vi.fn(),
    }

    mockBuilder = {
      build: vi.fn().mockResolvedValue({
        type: 'success',
        snapshot: {
          itemId: 'item-1' as ItemId,
          snapshot: { cipher: 'abc', iv: '123', kver: '1' },
        },
        heads: ['head-1'],
      }),
    }

    mockPushToLog = vi.fn().mockResolvedValue(undefined)
    mockOnSnapshotStored = vi.fn()

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
      listRecoveryItems: vi.fn().mockResolvedValue([]),
    }

    mockEventHub = {
      emit: vi.fn(),
    }

    pusher = new SnapshotPusher({
      accountId: 'test-acc',
      session: new SyncSessionState({ isLeader: true }),
      schedule: mockTracker as unknown as SnapshotSchedule,
      state: mockTracker,
      runPollNow: vi.fn().mockResolvedValue(undefined),
      isCaughtUp: () => true,
      hasPendingMarks: vi.fn().mockResolvedValue(false),
      builder: mockBuilder as unknown as SnapshotBuilder,
      pushToLog: mockPushToLog,
      onSnapshotStored: mockOnSnapshotStored,
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
    },
    heads: ['head-1'],
  })


  it('does nothing until snapshots are due', async () => {
    mockTracker.isDue.mockReturnValue(false)

    await expect(push()).resolves.toEqual({ persisted: 0, total: 0, success: true })

    expect(mockTracker.clearDue).not.toHaveBeenCalled()
    expect(mockBuilder.build).not.toHaveBeenCalled()
    expect(mockApiClient.putSnapshots).not.toHaveBeenCalled()
  })

  it('does nothing in a tab that is not the leader', async () => {
    pusher = new SnapshotPusher({
      accountId: 'test-acc',
      session: new SyncSessionState({ isLeader: false }),
      schedule: mockTracker as unknown as SnapshotSchedule,
      state: mockTracker,
      runPollNow: vi.fn().mockResolvedValue(undefined),
      isCaughtUp: () => true,
      hasPendingMarks: vi.fn().mockResolvedValue(false),
      builder: mockBuilder as unknown as SnapshotBuilder,
      pushToLog: mockPushToLog,
      onSnapshotStored: mockOnSnapshotStored,
      apiClient: mockApiClient,
      recoveryManager: mockRecoveryManager,
      eventHub: mockEventHub,
    })

    await push()

    expect(mockBuilder.build).not.toHaveBeenCalled()
  })

  it('clears the due time as it takes the dirty items', async () => {
    await push()

    expect(mockTracker.clearDue).toHaveBeenCalledTimes(1)
    expect(mockTracker.retryNextPoll).not.toHaveBeenCalled()
  })

  it('pushes dirty items to the log before it builds their snapshots', async () => {
    const order: string[] = []
    mockPushToLog.mockImplementation(async () => { order.push('log') })
    const built = await mockBuilder.build()
    mockBuilder.build.mockImplementation(async () => {
      order.push('build')
      return built
    })

    await push()

    expect(mockPushToLog).toHaveBeenCalledWith(['item-1'], expect.any(AbortSignal))
    expect(order).toEqual(['log', 'build'])
  })

  it('pushes again and rebuilds an item that changed after the first push', async () => {
    const built = await mockBuilder.build()
    mockBuilder.build.mockReset()
    mockBuilder.build.mockResolvedValueOnce({ type: 'deferred', reason: 'unpushed' }).mockResolvedValueOnce(built)

    await push()

    expect(mockPushToLog).toHaveBeenCalledTimes(2)
    expect(mockApiClient.putSnapshots).toHaveBeenCalledTimes(1)
  })

  it('leaves an item still deferred after the push to the next poll, counting no failure', async () => {
    mockBuilder.build.mockResolvedValue({ type: 'deferred', reason: 'unpushed' })

    await expect(push()).resolves.toEqual({ persisted: 0, total: 0, success: false })

    expect(mockApiClient.putSnapshots).not.toHaveBeenCalled()
    expect(mockRecoveryManager.quarantine).not.toHaveBeenCalled()
    expect(mockTracker.retryNextPoll).toHaveBeenCalledTimes(1)
  })

  it('pushes snapshots successfully and reports each stored snapshot', async () => {
    const result = await push()

    expect(result).toEqual({ persisted: 1, total: 1, success: true })
    expect(mockApiClient.putSnapshots).toHaveBeenCalledTimes(1)
    expectStored('item-1', 1, 2)
    expect(mockOnSnapshotStored).toHaveBeenCalledWith({ itemId: 'item-1', heads: ['head-1'] })
    expect(mockRecoveryManager.unquarantine).toHaveBeenCalledWith('item-1')
  })

  it('handles oversized item by quarantining and reporting a snapshot failure', async () => {
    mockBuilder.build.mockResolvedValue(oversizedSnapshot())

    const result = await push()

    expect(result).toEqual({ persisted: 0, total: 0, success: true })
    // Unconditionally, so it isn't retried while quarantined
    expect(mockTracker.clearDirty).toHaveBeenCalledWith('item-1')
    expect(mockEventHub.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'snapshotFailed', itemId: 'item-1' }),
    )
    expect(mockEventHub.emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'quotaExceeded' }))
    expect(mockRecoveryManager.quarantine).toHaveBeenCalledWith(
      'item-1',
      'oversized',
      { code: 'oversized', sizeKb: expect.any(Number) },
    )
  })

  it('warns about an oversized item once, and again after it is cleared', async () => {
    mockBuilder.build.mockResolvedValue(oversizedSnapshot())

    await push()
    await push()
    expect(mockRecoveryManager.quarantine).toHaveBeenCalledTimes(1)
    expect(mockEventHub.emit).toHaveBeenCalledTimes(1)

    pusher.clearOversized('item-1' as ItemId)
    await push()
    expect(mockRecoveryManager.quarantine).toHaveBeenCalledTimes(2)
  })

  it('does not warn again about an item an earlier session quarantined as oversized', async () => {
    mockBuilder.build.mockResolvedValue(oversizedSnapshot())
    mockRecoveryManager.listRecoveryItems.mockResolvedValue([{ itemId: 'item-1', kind: 'oversized' }])

    await push()

    expect(mockTracker.clearDirty).toHaveBeenCalledWith('item-1')
    expect(mockEventHub.emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'snapshotFailed' }))
    expect(mockRecoveryManager.quarantine).not.toHaveBeenCalled()
  })

  it('warns about an oversized item another kind of quarantine holds', async () => {
    mockBuilder.build.mockResolvedValue(oversizedSnapshot())
    mockRecoveryManager.listRecoveryItems.mockResolvedValue([{ itemId: 'item-1', kind: 'snapshotFailure' }])

    await push()

    expect(mockRecoveryManager.quarantine).toHaveBeenCalledWith('item-1', 'oversized', expect.anything())
  })

  describe('deleted oversized items', () => {
    const deletedSnapshot = (itemId: string) => ({
      type: 'success',
      snapshot: {
        itemId: itemId as ItemId,
        snapshot: { cipher: OVERSIZED_CIPHER, iv: '123', kver: '1' },
        deleted: true,
      },
      heads: ['head-1'],
    })

    beforeEach(() => {
      mockBuilder.build.mockResolvedValue(deletedSnapshot('item-1'))
    })

    it('uploads a metadata-only tombstone for a deleted oversized item instead of quarantining', async () => {
      const result = await push()

      expect(result).toEqual({ persisted: 1, total: 1, success: true })
      const payload = mockApiClient.putSnapshots.mock.calls[0][0]
      expect(payload.snapshots).toHaveLength(1)
      expect(payload.snapshots[0]).toEqual({
        itemId: 'item-1',
        deleted: true,
      })
      expect('snapshot' in payload.snapshots[0]).toBe(false)
      expect(mockTracker.clearDirty).not.toHaveBeenCalledWith('item-1')
      expect(mockRecoveryManager.quarantine).not.toHaveBeenCalled()
      expect(mockEventHub.emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'quotaExceeded' }))
      expectStored('item-1', 1, 2)
      expect(mockRecoveryManager.unquarantine).toHaveBeenCalledWith('item-1')
      expect(mockOnSnapshotStored).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'item-1', heads: undefined }))
      expect(pusher['oversizedItems'].has('item-1' as ItemId)).toBe(false)
    })

    it('batches a tombstone alongside normal snapshots and confirms each, with heads only for the normal one', async () => {
      mockTracker.listDirty.mockReturnValue(['item-1' as ItemId, 'item-2' as ItemId])
      mockBuilder.build.mockImplementation(async (itemId: string) => {
        if (itemId === 'item-1') return deletedSnapshot('item-1')
        return {
          type: 'success',
          snapshot: {
            itemId: 'item-2' as ItemId,
            snapshot: { cipher: 'def', iv: '456', kver: '1' },
          },
          heads: ['head-2'],
        }
      })
      mockApiClient.putSnapshots.mockResolvedValue({
        success: true,
        persisted: 2,
        results: [{ itemId: 'item-1', version: 3 }, { itemId: 'item-2', version: 4 }],
      })

      const result = await push()

      expect(result).toEqual({ persisted: 2, total: 2, success: true })
      expect(mockApiClient.putSnapshots).toHaveBeenCalledTimes(1)
      expect(mockApiClient.putSnapshots.mock.calls[0][0].snapshots).toHaveLength(2)
      expectStored('item-1', 1, 3)
      expectStored('item-2', 1, 4)
      expect(mockOnSnapshotStored).toHaveBeenCalledTimes(2)
      expect(mockOnSnapshotStored).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'item-1', heads: undefined }))
      expect(mockOnSnapshotStored).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'item-2', heads: ['head-2'] }))
    })
  })

  it('quarantines item after 5 consecutive failures', async () => {
    mockBuilder.build.mockResolvedValue({
      type: 'error',
      reason: 'Failed to encrypt',
    })

    // 4 failures
    for (let i = 0; i < 4; i++) {
      await push()
      expect(pusher['consecutiveFailures']['count']('item-1' as ItemId)).toBe(i + 1)
      expect(mockRecoveryManager.quarantine).not.toHaveBeenCalled()
    }

    // 5th failure triggers quarantine
    await push()

    expect(pusher['consecutiveFailures']['count']('item-1' as ItemId)).toBe(0)
    expect(mockTracker.clearDirty).toHaveBeenCalledWith('item-1', 1)
    expect(mockEventHub.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'snapshotFailed', itemId: 'item-1' }),
    )
    expect(mockRecoveryManager.quarantine).toHaveBeenCalledWith(
      'item-1',
      'snapshotFailure',
      { code: 'snapshotFailed', stage: 'build' },
    )
  })


  it('leaves items the server did not store to the next poll', async () => {
    mockApiClient.putSnapshots.mockResolvedValue({ success: false, persisted: 0, results: [] })

    await expect(push()).resolves.toEqual({ persisted: 0, total: 1, success: false })

    expect(mockTracker.retryNextPoll).toHaveBeenCalledTimes(1)
  })

  // Sync rule 4: a request that fails fails the poll, which backs off
  it('throws when the upload request fails, leaving the items to the next poll', async () => {
    const error = new TypeError('Failed to fetch')
    mockApiClient.putSnapshots.mockRejectedValue(error)

    await expect(push()).rejects.toBe(error)

    expect(mockTracker.retryNextPoll).toHaveBeenCalledTimes(1)
    expect(pusher['consecutiveFailures']['count']('item-1' as ItemId)).toBe(0)
    expect(mockRecoveryManager.quarantine).not.toHaveBeenCalled()
  })

  // Only a request failure says nothing about the items; a batch the server rejects is theirs
  it('counts a batch the server rejects against its items, without failing the poll', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockApiClient.putSnapshots.mockRejectedValue({ data: { httpStatus: 400 }, message: 'Bad Request: Invalid snapshot schema' })

    await expect(push()).resolves.toEqual({ persisted: 0, total: 1, success: false })

    expect(mockTracker.retryNextPoll).toHaveBeenCalledTimes(1)
    expect(pusher['consecutiveFailures']['count']('item-1' as ItemId)).toBe(1)
  })

  describe('uploadItems', () => {
    it('builds items that are not dirty when asked to, and reports each result', async () => {
      mockTracker.getDirtyTick.mockReturnValue(undefined)
      const onItemResult = vi.fn()

      await pusher.uploadItems(['item-1' as ItemId], {
        signal: new AbortController().signal,
        includeClean: true,
        onItemResult,
      })

      expect(mockApiClient.putSnapshots).toHaveBeenCalledTimes(1)
      expect(mockTracker.raiseBaseVersion).toHaveBeenCalledWith('item-1', 2)
      expect(mockTracker.clearDirty).not.toHaveBeenCalled()
      expect(onItemResult).toHaveBeenCalledWith('item-1', { type: 'stored' })
    })

    it('skips items that are not dirty otherwise', async () => {
      mockTracker.getDirtyTick.mockReturnValue(undefined)
      const onItemResult = vi.fn()

      await pusher.uploadItems(['item-1' as ItemId], { signal: new AbortController().signal, onItemResult })

      expect(mockBuilder.build).not.toHaveBeenCalled()
      expect(onItemResult).not.toHaveBeenCalled()
    })

    it('reports an oversized item without uploading or quarantining it again', async () => {
      mockTracker.getDirtyTick.mockReturnValue(undefined)
      // An earlier session quarantined it as oversized
      mockRecoveryManager.listRecoveryItems.mockResolvedValue([{ itemId: 'item-1', kind: 'oversized' }])
      mockBuilder.build.mockResolvedValue(oversizedSnapshot())
      const onItemResult = vi.fn()

      await pusher.uploadItems(['item-1' as ItemId], {
        signal: new AbortController().signal,
        includeClean: true,
        onItemResult,
      })

      expect(mockApiClient.putSnapshots).not.toHaveBeenCalled()
      expect(mockRecoveryManager.quarantine).not.toHaveBeenCalled()
      expect(onItemResult).toHaveBeenCalledWith('item-1', { type: 'oversized', sizeBytes: expect.any(Number) })
    })

    it('reports a failure that quarantines an item, leaving the queue alone for a clean one', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      mockTracker.getDirtyTick.mockReturnValue(undefined)
      mockBuilder.build.mockResolvedValue({ type: 'error', reason: 'Failed to encrypt' })
      const onItemResult = vi.fn()

      for (let i = 0; i < 5; i += 1) {
        await pusher.uploadItems(['item-1' as ItemId], {
          signal: new AbortController().signal,
          includeClean: true,
          onItemResult,
        })
      }

      expect(onItemResult).toHaveBeenNthCalledWith(4, 'item-1', expect.objectContaining({ type: 'failed', quarantined: false }))
      expect(onItemResult).toHaveBeenNthCalledWith(5, 'item-1', {
        type: 'failed',
        stage: 'build',
        reason: 'Failed to encrypt',
        quarantined: true,
      })
      expect(mockTracker.clearDirty).not.toHaveBeenCalled()
      expect(mockRecoveryManager.quarantine).toHaveBeenCalledTimes(1)
    })
  })

  it('throws when pushing to the log fails, before building anything', async () => {
    const error = new Error('Network disconnected')
    mockPushToLog.mockRejectedValue(error)

    await expect(push()).rejects.toBe(error)

    expect(mockBuilder.build).not.toHaveBeenCalled()
  })

  // So the poll pauses for auth, rather than the device retrying alone with an expired session
  it('throws an auth failure', async () => {
    mockApiClient.putSnapshots.mockRejectedValue(new AuthError('No active session token available'))

    await expect(push()).rejects.toBeInstanceOf(AuthError)
  })

  // Over the storage quota the whole request is refused, and nothing is wrong with its items or with pulls
  it('defers snapshots without failing the poll or counting an item failure when the account is over its quota', async () => {
    vi.setSystemTime(10_000)
    mockApiClient.putSnapshots.mockRejectedValue(quotaError())

    // More attempts than it takes to quarantine an item that keeps failing
    for (let i = 0; i < 6; i += 1) {
      await expect(push()).resolves.toEqual({ persisted: 0, total: 0, success: false })
    }

    expect(mockTracker.deferUntil).toHaveBeenCalledWith(10_000 + SYNC_TIMEOUTS.snapshotQuotaRetry)
    expect(mockTracker.retryNextPoll).not.toHaveBeenCalled()
    expect(pusher['consecutiveFailures']['count']('item-1' as ItemId)).toBe(0)
    expect(mockRecoveryManager.quarantine).not.toHaveBeenCalled()
    expect(mockTracker.clearDirty).not.toHaveBeenCalled()
  })

  it('keeps what an earlier batch stored when the server refuses a later one for the quota', async () => {
    mockTracker.listDirty.mockReturnValue(['item-1' as ItemId, 'item-2' as ItemId])
    mockBuilder.build.mockImplementation(async (itemId: string) => ({
      type: 'success',
      snapshot: { itemId, snapshot: { cipher: 'c'.repeat(600), iv: '1', kver: '1' } },
      heads: ['h'],
    }))
    mockApiClient.putSnapshots
      .mockResolvedValueOnce({ success: true, persisted: 1, results: [{ itemId: 'item-1', version: 2 }] })
      .mockRejectedValueOnce(quotaError())

    await expect(push()).resolves.toEqual({ persisted: 0, total: 0, success: false })

    expect(mockApiClient.putSnapshots).toHaveBeenCalledTimes(2)
    expectStored('item-1', 1, 2)
    expect(mockTracker.deferUntil).toHaveBeenCalledTimes(1)
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
      mockTracker.listDirty.mockReturnValue(['item-1' as ItemId, 'item-2' as ItemId])
      mockApiClient.putSnapshots.mockResolvedValue({
        success: true,
        persisted: 1,
        results: [{ itemId: 'item-2', version: 2 }],
      })

      pusher = new SnapshotPusher({
        accountId: 'test-acc',
        session: new SyncSessionState({ isLeader: true }),
        schedule: mockTracker as unknown as SnapshotSchedule,
        state: mockTracker,
        runPollNow: vi.fn().mockResolvedValue(undefined),
        isCaughtUp: () => true,
        hasPendingMarks: vi.fn().mockResolvedValue(false),
        builder: new SnapshotBuilder(mockRepo, keys, passthroughCodec, noLogCoverage),
        pushToLog: mockPushToLog,
        onSnapshotStored: mockOnSnapshotStored,
        apiClient: mockApiClient,
        recoveryManager: mockRecoveryManager,
        eventHub: mockEventHub,
        maxPayloadBytes: 10_000,
      })
    })


    it('fails that item after the lookup timeout and still uploads the later items', async () => {
      let settled = false
      const run = push().then(result => {
        settled = true
        return result
      })

      await vi.advanceTimersByTimeAsync(SYNC_TIMEOUTS.snapshotDocLookup - 1)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)

      await expect(run).resolves.toEqual({ persisted: 1, total: 1, success: false })
      expect(mockApiClient.putSnapshots).toHaveBeenCalledTimes(1)
      expect(mockApiClient.putSnapshots.mock.calls[0][0].snapshots.map((s: any) => s.itemId)).toEqual(['item-2'])
      expect(pusher['consecutiveFailures']['count']('item-1' as ItemId)).toBe(1)
      // A failed item leaves the push unsuccessful, so the next poll tries again
      expect(mockTracker.retryNextPoll).toHaveBeenCalledTimes(1)
    })

    it('quarantines the item once its lookups have timed out too many times', async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const run = push()
        await vi.advanceTimersByTimeAsync(SYNC_TIMEOUTS.snapshotDocLookup)
        await run
      }

      expect(mockTracker.clearDirty).toHaveBeenCalledWith('item-1', 1)
      expect(mockRecoveryManager.quarantine).toHaveBeenCalledWith(
        'item-1',
        'snapshotFailure',
        { code: 'snapshotFailed', stage: 'build' },
      )
    })

    it('stops at once when the poll is aborted, without counting a failure', async () => {
      const controller = new AbortController()
      const run = push(controller.signal)
      await vi.waitFor(() => expect(findSignals.has('automerge:item-1')).toBe(true))

      controller.abort()

      await expect(run).rejects.toThrow()
      expect(findSignals.get('automerge:item-1')?.aborted).toBe(true)
      expect(mockRepo.find).toHaveBeenCalledTimes(1)
      expect(mockApiClient.putSnapshots).not.toHaveBeenCalled()
      expect(pusher['consecutiveFailures']['counts'].size).toBe(0)
      expect(mockRecoveryManager.quarantine).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    })
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

    let tracker: SnapshotSchedule
    let state: ItemSyncState
    let session: SyncSessionState
    let mockRepo: any
    let mockHandle: any
    let records: ReturnType<typeof createMemoryItemRecords>

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


    /** Replaces `tracker` and `pusher` with a real tracker wired to a pusher, as the context wires them */
    function createPusher(options: { maxPayloadBytes?: number } = {}): void {
      session = new SyncSessionState({ isLeader: true })
      state = new ItemSyncState({ db: records.db, session })
      tracker = new SnapshotSchedule({
        state,
        recoveryManager: mockRecoveryManager,
        session,
      })
      pusher = new SnapshotPusher({
        accountId: 'test-account',
        session,
        schedule: tracker,
        state,
        runPollNow: vi.fn().mockResolvedValue(undefined),
        isCaughtUp: () => true,
        hasPendingMarks: vi.fn().mockResolvedValue(false),
        builder: new SnapshotBuilder(mockRepo, keys, passthroughCodec, noLogCoverage),
        pushToLog: mockPushToLog,
        onSnapshotStored: mockOnSnapshotStored,
        recoveryManager: mockRecoveryManager,
        apiClient: new SyncApiClient(),
        eventHub: mockEventHub,
        maxPayloadBytes: options.maxPayloadBytes,
      })
    }

    /** Makes every dirty item due and runs the snapshot phase, as a flush does */
    function uploadNow() {
      tracker.requestNow()
      return push()
    }

    /** Simulates a worker restart: drops the in-memory state and replaces it with a fresh tracker and pusher */
    async function restart(): Promise<void> {
      session.markShutdown()
      pusher.shutdown()
      await tracker.shutdown()
      await state.shutdown({ clearLocalData: true })
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

      setApiAuthToken('mock-auth-token')

      mockHandle = {
        isReady: vi.fn().mockReturnValue(true),
        doc: vi.fn().mockReturnValue({ id: 'item-1', type: 'note' }),
      }
      mockRepo = {
        find: vi.fn().mockResolvedValue(mockHandle),
      }
      mockRecoveryManager = new RecoveryManager({ accountId: 'test-account', eventHub: mockEventHub })
      records = createMemoryItemRecords()
      createPusher()
    })

    describe('retries', () => {
      it('successfully pushes snapshots', async () => {
        mockPutSnapshots.mockResolvedValue({
          success: true,
          persisted: 1,
        })

        tracker.markItemDirty('item-1' as ItemId)
        await uploadNow()

        expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
        expect(tracker.isDue()).toBe(false)
      })

      it('uploads once the debounce has passed, at the next poll', async () => {
        mockPutSnapshots.mockResolvedValue({ success: true, persisted: 1 })
        vi.setSystemTime(1000)
        tracker.markItemDirty('item-1' as ItemId)

        await push()
        expect(mockPutSnapshots).not.toHaveBeenCalled()

        vi.setSystemTime(1000 + SYNC_TIMEOUTS.snapshotDebounce)
        await push()
        expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
      })

      it('clears the dirty flag and records the version on a successful push', async () => {
        mockPutSnapshots.mockResolvedValue({
          success: true,
          persisted: 1,
          total: 1,
        })

        tracker.markItemDirty('item-1' as ItemId)
        await uploadNow()
        await state.save()

        expect(records.get('item-1')).toEqual({ itemId: 'item-1', baseVersion: 1 })
      })

      it('leaves an item whose doc is not ready to the next poll', async () => {
        mockHandle.isReady.mockReturnValue(false)

        tracker.markItemDirty('item-1' as ItemId)
        await uploadNow()

        expect(mockPutSnapshots).not.toHaveBeenCalled()
        expect(state.listDirty()).toContain('item-1' as ItemId)
        expect(tracker.isDue()).toBe(true)
        // A retry waits for the next poll; it doesn't bring one forward
        expect(tracker.nextDueAt).toBeUndefined()

        // When the handle is ready at the next poll
        mockHandle.isReady.mockReturnValue(true)
        mockPutSnapshots.mockResolvedValue({
          success: true,
          persisted: 1,
        })

        await push()

        expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
        expect(state.listDirty()).not.toContain('item-1' as ItemId)
        expect(tracker.isDue()).toBe(false)
      })

      it('retries at the next poll when some items succeed but another is not ready', async () => {
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
        await uploadNow()

        expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
        expect(state.listDirty()).not.toContain('item-1' as ItemId)
        expect(state.listDirty()).toContain('item-2' as ItemId)
        expect(tracker.isDue()).toBe(true)
      })

      it('throws if putSnapshots throws, leaving the items to the next poll', async () => {
        mockPutSnapshots.mockRejectedValue(new TypeError('Failed to fetch'))

        tracker.markItemDirty('item-1' as ItemId)
        await expect(uploadNow()).rejects.toThrow('Failed to fetch')

        expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
        expect(state.listDirty()).toContain('item-1' as ItemId)
        expect(tracker.isDue()).toBe(true)
      })

      it('retains dirty items for the next poll when putSnapshots returns persisted: 0 even if success is true', async () => {
        mockPutSnapshots.mockResolvedValue({
          success: true,
          persisted: 0,
          total: 1,
        })

        tracker.markItemDirty('item-1' as ItemId)
        await uploadNow()

        expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
        expect(state.listDirty()).toContain('item-1' as ItemId)
        expect(tracker.isDue()).toBe(true)
      })

      it('retains dirty items for the next poll when putSnapshots returns persisted less than batch length', async () => {
        mockPutSnapshots.mockResolvedValue({
          success: false,
          persisted: 1,
          total: 2,
        })

        tracker.markItemDirty('item-1' as ItemId)
        tracker.markItemDirty('item-2' as ItemId)
        await uploadNow()

        expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
        expect(state.listDirty()).toContain('item-1' as ItemId)
        expect(state.listDirty()).toContain('item-2' as ItemId)
        expect(tracker.isDue()).toBe(true)
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
        await uploadNow()

        expect(state.listDirty()).not.toContain('item-1' as ItemId)
        expect(state.getBaseVersion('item-1' as ItemId)).toBe(7)
        expect(state.listDirty()).toContain('item-2' as ItemId)
        expect(pusher['consecutiveFailures']['count']('item-2' as ItemId)).toBe(1)
        expect(tracker.isDue()).toBe(true)
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
          await uploadNow()
        }

        expect(state.listDirty()).not.toContain('item-2' as ItemId)
        expect(mockUpsertManualRecoveryEntry).toHaveBeenCalledWith(
          'test-account',
          expect.objectContaining({ itemId: 'item-2', kind: 'snapshotFailure' }),
        )
        expect(mockEventHub.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'snapshotFailed', itemId: 'item-2' }))
      })

      it('waits out the quota delay, then uploads at the next poll after it', async () => {
        vi.setSystemTime(1000)
        mockPutSnapshots.mockRejectedValueOnce(quotaError())
        tracker.markItemDirty('item-1' as ItemId)

        await expect(uploadNow()).resolves.toEqual({ persisted: 0, total: 0, success: false })
        expect(tracker.isDue()).toBe(false)

        // A new edit, even one requested at once, is due no sooner than the quota delay allows
        tracker.markItemDirty('item-2' as ItemId, 0)
        expect(tracker.nextDueAt).toBe(1000 + SYNC_TIMEOUTS.snapshotQuotaRetry)

        vi.setSystemTime(1000 + SYNC_TIMEOUTS.snapshotQuotaRetry)
        mockPutSnapshots.mockResolvedValue({ success: true, persisted: 2 })
        await push()

        expect(mockPutSnapshots).toHaveBeenCalledTimes(2)
        expect(state.listDirty()).toHaveLength(0)
      })

      it('uploads at once when asked to, even while waiting out the quota delay', async () => {
        mockPutSnapshots.mockRejectedValueOnce(quotaError())
        tracker.markItemDirty('item-1' as ItemId)
        await uploadNow()

        mockPutSnapshots.mockResolvedValue({ success: true, persisted: 1 })
        await uploadNow()

        expect(mockPutSnapshots).toHaveBeenCalledTimes(2)
        expect(state.listDirty()).toHaveLength(0)
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

        await uploadNow()

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
        await uploadNow()

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
        await uploadNow()

        // Should not be pushed, and should be removed from dirtyItems to avoid retry loops
        expect(mockPutSnapshots).not.toHaveBeenCalled()
        expect(state.listDirty()).not.toContain('item-1' as ItemId)
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
        const run = push()
        await vi.waitFor(() => expect(mockPutSnapshots).toHaveBeenCalledTimes(1))

        // While upload is in flight, item-1 is modified again
        tracker.markItemDirty('item-1' as ItemId)

        // Complete the in-flight upload
        resolveUpload!({
          success: true,
          persisted: 1,
        })
        await run

        // item-1 should still be dirty because it was modified after batch preparation
        expect(state.listDirty()).toContain('item-1' as ItemId)
        // ...and due again after the debounce of that edit
        expect(tracker.nextDueAt).toBeDefined()
      })

      it('clears dirty status if item was not modified during in flight upload', async () => {
        mockPutSnapshots.mockResolvedValue({
          success: true,
          persisted: 1,
        })

        tracker.markItemDirty('item-1' as ItemId)
        await uploadNow()

        expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
        expect(state.listDirty()).not.toContain('item-1' as ItemId)
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

        await uploadNow()

        expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
        // Both item-1 and item-2 should be cleanly cleared because item-2 was built with the new tick
        expect(state.listDirty()).not.toContain('item-1' as ItemId)
        expect(state.listDirty()).not.toContain('item-2' as ItemId)
      })
    })

    describe('Not-Ready vs Error Build Failure Handling', () => {
      it('does not increment consecutiveBuildFailures or drop item when handle is not ready', async () => {
        mockHandle.isReady.mockReturnValue(false)

        tracker.markItemDirty('item-1' as ItemId)

        // Run 6 push attempts
        for (let i = 0; i < 6; i += 1) {
          await uploadNow()
        }

        // Should still be dirty and failures map should not have counted failures
        expect(state.listDirty()).toContain('item-1' as ItemId)
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
          await uploadNow()
        }

        // Item should now be dropped from active dirty queue
        expect(state.listDirty()).not.toContain('item-1' as ItemId)
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
            detail: { code: 'snapshotFailed', stage: 'build' },
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
          await uploadNow()
        }

        // Item must remain dirty and NOT be dropped
        expect(state.listDirty()).toContain('item-1' as ItemId)
        expect(pusher['consecutiveFailures']['count']('item-1' as ItemId)).toBe(0)
        expect(mockEventHub.emit).not.toHaveBeenCalledWith(
          expect.objectContaining({ type: 'snapshotFailed' }),
        )
        expect(mockUpsertManualRecoveryEntry).not.toHaveBeenCalled()
      })

      it('does not drop items or count failures when batch network send fails', async () => {
        mockPutSnapshots.mockRejectedValue(new TypeError('Failed to fetch'))

        tracker.markItemDirty('item-1' as ItemId)
        tracker.markItemDirty('item-2' as ItemId)

        // Run 6 push attempts where network fails
        for (let i = 0; i < 6; i += 1) {
          await expect(uploadNow()).rejects.toThrow('Failed to fetch')
        }

        // Items must remain dirty for subsequent retry and NOT be dropped
        expect(state.listDirty()).toContain('item-1' as ItemId)
        expect(state.listDirty()).toContain('item-2' as ItemId)
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
        await uploadNow()

        expect(mockRemoveManualRecoveryEntryByItemId).toHaveBeenCalledWith('test-account', 'item-1')
      })
    })

    describe('Oversized Snapshots', () => {
      it('notifies client eventHub and records to manualRecoveryStore without silent abandonment', async () => {
        // Very small limit so snapshot exceeds it
        createPusher({ maxPayloadBytes: 10 })

        tracker.markItemDirty('item-1' as ItemId)
        await uploadNow()

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
            detail: { code: 'oversized', sizeKb: expect.any(Number) },
          }),
        )
      })

      it('suppresses repeated error logs and repeated manual recovery upserts on subsequent pushes for the same oversized item', async () => {
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        createPusher({ maxPayloadBytes: 10 })

        tracker.markItemDirty('item-1' as ItemId)
        await uploadNow()

        // First attempt logs error and upserts manual recovery
        const firstErrorCallCount = consoleErrorSpy.mock.calls.filter(c => String(c[0]).includes('exceeds maxPayloadBytes')).length
        expect(firstErrorCallCount).toBe(1)
        expect(mockUpsertManualRecoveryEntry).toHaveBeenCalledTimes(1)

        // Re-mark dirty (e.g. from WAL re-negotiation or local change)
        tracker.markItemDirty('item-1' as ItemId)
        await uploadNow()

        // Should NOT log error again or re-upsert manual recovery
        const secondErrorCallCount = consoleErrorSpy.mock.calls.filter(c => String(c[0]).includes('exceeds maxPayloadBytes')).length
        expect(secondErrorCallCount).toBe(1)
        expect(mockUpsertManualRecoveryEntry).toHaveBeenCalledTimes(1)

        consoleErrorSpy.mockRestore()
      })

      it('does not treat batch as failed or retry when an oversized item is skipped alongside normal items', async () => {
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

        const result = await uploadNow()

        // Only item-2 pushed
        expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
        expect(mockPutSnapshots.mock.calls[0][0].snapshots[0].itemId).toBe('item-2')
        expect(state.listDirty()).toHaveLength(0)
        expect(result.success).toBe(true)
        expect(tracker.isDue()).toBe(false)
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
        await uploadNow()

        expect(mockPutSnapshots).not.toHaveBeenCalled()
        expect(pusher['oversizedItems'].has('item-1' as ItemId)).toBe(true)

        // Step 2: Compaction occurs -> encrypted payload is now small (< 200 bytes)
        vi.mocked(encryptBytes).mockResolvedValueOnce({
          iv: 'mock-iv',
          cipher: 'small-cipher',
          kver: '1',
        })

        // Step 3: Marked dirty after compaction
        tracker.markItemDirty('item-1' as ItemId)
        await uploadNow()

        // Now successfully pushed and cleared from oversizedItems
        expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
        expect(mockPutSnapshots.mock.calls[0][0].snapshots[0].itemId).toBe('item-1')
        expect(pusher['oversizedItems'].has('item-1' as ItemId)).toBe(false)
        expect(state.listDirty()).not.toContain('item-1' as ItemId)
      })
    })

    describe('Missing Auth Token Handling', () => {
      it('throws an auth failure when there is no session token, keeping the items dirty', async () => {
        setApiAuthToken('')

        tracker.markItemDirty('item-1' as ItemId)
        await expect(uploadNow()).rejects.toBeInstanceOf(AuthError)

        expect(mockPutSnapshots).not.toHaveBeenCalled()
        expect(state.listDirty()).toContain('item-1' as ItemId)
        expect(pusher['consecutiveFailures']['count']('item-1' as ItemId)).toBe(0)
      })

      it('pushes the snapshots at the next poll once the auth token is back', async () => {
        setApiAuthToken('')
        const tokensSent: string[] = []
        mockPutSnapshots.mockImplementation(async () => {
          tokensSent.push(getApiAuthToken())
          return { success: true, persisted: 1 }
        })

        tracker.markItemDirty('item-1' as ItemId)
        await expect(uploadNow()).rejects.toBeInstanceOf(AuthError)
        expect(mockPutSnapshots).not.toHaveBeenCalled()

        setApiAuthToken('restored-auth-token')
        await push()

        expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
        expect(tokensSent).toEqual(['restored-auth-token'])
        expect(state.listDirty()).not.toContain('item-1' as ItemId)
      })

      it('does nothing without a token when no item is dirty', async () => {
        setApiAuthToken('')

        const result = await uploadNow()

        expect(result).toEqual({ persisted: 0, total: 0, success: true })
        expect(mockPutSnapshots).not.toHaveBeenCalled()
      })

      it('does not increment consecutiveFailures or move items to manual recovery when auth token is missing repeatedly', async () => {
        setApiAuthToken('')

        tracker.markItemDirty('item-1' as ItemId)
        for (let i = 0; i < 6; i += 1) {
          await expect(uploadNow()).rejects.toBeInstanceOf(AuthError)
        }

        expect(state.listDirty()).toContain('item-1' as ItemId)
        expect(pusher['consecutiveFailures']['count']('item-1' as ItemId)).toBe(0)
        expect(mockUpsertManualRecoveryEntry).not.toHaveBeenCalled()
      })
    })

    describe('dirty flags across an upload', () => {
      it('clears the flag once the upload is confirmed', async () => {
        vi.setSystemTime(1000)
        tracker.markItemDirty('item-1' as ItemId)
        await vi.advanceTimersByTimeAsync(1000)
        expect(records.get('item-1')).toEqual({ itemId: 'item-1', dirty: true })

        mockPutSnapshots.mockResolvedValue({
          success: true,
          persisted: 1,
        })

        // The poll after the debounce runs
        vi.setSystemTime(1000 + SYNC_TIMEOUTS.snapshotDebounce)
        await push()
        await vi.advanceTimersByTimeAsync(1000)

        expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
        expect(records.get('item-1')).toEqual({ itemId: 'item-1', baseVersion: 1 })
      })

      it('keeps the flag if modified again while upload is in flight', async () => {
        vi.setSystemTime(1000)
        tracker.markItemDirty('item-1' as ItemId)
        await vi.advanceTimersByTimeAsync(1000)

        let resolveUpload: (val: any) => void
        const uploadPromise = new Promise(resolve => {
          resolveUpload = resolve
        })
        mockPutSnapshots.mockImplementation(() => uploadPromise)

        // The poll after the debounce starts
        vi.setSystemTime(1000 + SYNC_TIMEOUTS.snapshotDebounce)
        const run = push()
        await vi.advanceTimersByTimeAsync(0)
        expect(mockPutSnapshots).toHaveBeenCalledTimes(1)

        // While upload is in flight, user modifies item-1 again
        tracker.markItemDirty('item-1' as ItemId)

        // Upload completes for the snapshot built before the edit
        resolveUpload!({
          success: true,
          persisted: 1,
        })
        await run
        await vi.advanceTimersByTimeAsync(1000)

        expect(state.listDirty()).toContain('item-1')
        expect(records.get('item-1')).toEqual({ itemId: 'item-1', baseVersion: 1, dirty: true })
      })

      it('re-enqueues an item after a restart if a local edit occurs during snapshot encryption (C3 fix)', async () => {
        vi.setSystemTime(1000)
        tracker.markItemDirty('item-1' as ItemId)
        await vi.advanceTimersByTimeAsync(1000)

        const { encryptBytes } = vault
        vi.mocked(encryptBytes).mockImplementationOnce(async () => {
          // A local edit arrives while encryption is in flight
          tracker.markItemDirty('item-1' as ItemId)
          return { iv: 'mock-iv', cipher: 'mock-cipher', kver: '1' }
        })

        mockPutSnapshots.mockResolvedValueOnce({
          success: true,
          persisted: 1,
        })

        // The poll after the debounce runs
        vi.setSystemTime(1000 + SYNC_TIMEOUTS.snapshotDebounce)
        await push()

        // The edit made during encryption keeps the item dirty
        expect(state.listDirty()).toContain('item-1')

        // Save the records and simulate restart / promotion audit
        await state.save()
        await restart()
        expect(state.listDirty()).not.toContain('item-1')

        await tracker.load()
        expect(state.listDirty()).toContain('item-1')
      })
    })
  })
})
