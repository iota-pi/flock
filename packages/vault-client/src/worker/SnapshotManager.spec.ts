import type { ItemId } from '@vault/shared'
import { SnapshotManager, type SnapshotManagerOptions } from './SnapshotManager'
import { SyncSessionState } from './SyncSessionState'
import { RecoveryManager } from './RecoveryManager'
import { passthroughCodec, type DocCodec } from './domain'
import { SnapshotBuilder } from './SnapshotBuilder'
import type { Repo } from '@automerge/automerge-repo/slim'
import { SyncApiClient } from './SyncApiClient'
import { LastModifiedStore } from './stores/LastModifiedStore'
import { setApiAuthToken } from '../keys/runtime'
import { createMockKeyProvider, createMockVault, spyOnVaultTrpc } from './__test__/testUtils'
import { spyOnExports } from '../../test/moduleMocks'
import type { KeyProvider } from '../keys/Keyring'
import * as manualRecoveryStoreModule from '../shared/manualRecoveryStore'
import * as automergeModule from './utils/automerge'
import * as Automerge from '@automerge/automerge/slim'
import * as docStore from './docStore'

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

const sessions = new WeakMap<SnapshotManager, SyncSessionState>()

/** A manager with its own session state, a leader's when `isLeader` is set */
function createManager(
  context: Omit<ConstructorParameters<typeof SnapshotManager>[0], 'session' | 'lastModifiedStore' | 'builder'> & {
    repo: Repo
    keys: KeyProvider
    codec?: DocCodec
  },
  lastModifiedStore: LastModifiedStore,
  options: SnapshotManagerOptions & { isLeader?: boolean } = {},
): SnapshotManager {
  const { isLeader, ...managerOptions } = options
  const { repo, keys, codec = passthroughCodec, ...deps } = context
  const session = new SyncSessionState({ isLeader })
  const builder = new SnapshotBuilder(repo, keys, codec)
  const created = new SnapshotManager({ ...deps, session, lastModifiedStore, builder }, managerOptions)
  sessions.set(created, session)
  return created
}

/** Changes the session's leadership and tells the manager, as the context does */
async function setLeader(target: SnapshotManager, isLeader: boolean): Promise<void> {
  if (sessions.get(target)!.setLeader(isLeader)) {
    await target.onLeaderChange()
  }
}

/** Changes the session's online state and tells the manager, as the context does */
function setOnline(target: SnapshotManager, isOnline: boolean): void {
  if (sessions.get(target)!.setOnline(isOnline)) {
    target.onOnlineStateChange()
  }
}

/** Marks the session shut down and stops the manager, as the context does */
function shutDown(target: SnapshotManager, options?: { clearLocalData?: boolean }): Promise<void> {
  sessions.get(target)!.markShutdown()
  return target.shutdown(options)
}

function isLeader(target: SnapshotManager): boolean {
  return sessions.get(target)!.isLeader
}

function createMockBroker() {
  return {
    confirmSnapshot: vi.fn(),
  } as any
}

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

beforeEach(() => {
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
  vi.spyOn(docStore, 'normalizeItemSnapshot').mockReturnValue({ type: 'note' } as any)
})

describe('SnapshotManager', () => {
  let manager: SnapshotManager
  let mockRepo: any
  let mockHandle: any
  let mockEventHub: { emit: ReturnType<typeof vi.fn> }
  let context: {
    accountId: string | null
    repo: any
    broker: any
    eventHub: any
    recoveryManager: RecoveryManager
    apiClient: SyncApiClient
    keys: KeyProvider
  }
  let lastModifiedStore: LastModifiedStore

  beforeEach(async () => {
    // The store persists between tests, and saves merge into it
    await new LastModifiedStore('test-account').clear()
    vi.useFakeTimers()
    vi.clearAllMocks()
    setApiAuthToken('mock-auth-token')

    mockHandle = {
      isReady: vi.fn().mockReturnValue(true),
      doc: vi.fn().mockReturnValue({ id: 'item-1', type: 'note' }),
    }

    mockRepo = {
      find: vi.fn().mockResolvedValue(mockHandle),
    }

    mockEventHub = {
      emit: vi.fn(),
    }

    context = {
      accountId: 'test-account',
      repo: mockRepo,
      broker: createMockBroker(),
      eventHub: mockEventHub,
      recoveryManager: new RecoveryManager({ accountId: 'test-account', eventHub: mockEventHub as any }),
      apiClient: new SyncApiClient(),
      keys,
    }

    lastModifiedStore = new LastModifiedStore('test-account')
    manager = createManager(context as any, lastModifiedStore, { isLeader: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('pauses and clears retry timers when going offline', async () => {
    mockPutSnapshots.mockResolvedValue({
      success: false,
      persisted: 0,
    })

    manager.tracker.markItemDirty('item-1' as ItemId)
    await manager.flushPendingSnapshots()
    expect(manager['pusher'].retryAttempt).toBe(1)
    expect(manager['pusher'].isRetryActive).toBe(true)

    // Go offline
    setOnline(manager, false)
    expect(manager['pusher'].isRetryActive).toBe(false)

    // Advance time, no additional retry should occur
    await vi.advanceTimersByTimeAsync(10000)
    expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
  })

  it('triggers immediate push when coming online with pending snapshots', async () => {
    // 1. Set up failed push and verify it schedules a retry
    mockPutSnapshots.mockResolvedValue({
      success: false,
      persisted: 0,
    })

    manager.tracker.markItemDirty('item-1' as ItemId)
    await manager.flushPendingSnapshots()
    expect(manager['pusher'].retryAttempt).toBe(1)

    // 2. Go offline (clears retry timer)
    setOnline(manager, false)
    expect(manager['pusher'].isRetryActive).toBe(false)

    // 3. Make next call succeed
    mockPutSnapshots.mockResolvedValue({
      success: true,
      persisted: 1,
    })

    // 4. Come back online
    setOnline(manager, true)
    await vi.advanceTimersByTimeAsync(0)

    // Immediate push should have happened and succeeded
    expect(mockPutSnapshots).toHaveBeenCalledTimes(2)
    expect(manager['pusher'].retryAttempt).toBe(0)
  })

  it('saves pending timestamps at once when flushed, even in a follower tab', async () => {
    const follower = createManager(context as any, lastModifiedStore, { isLeader: false })
    const saveSpy = vi.spyOn(lastModifiedStore, 'saveTimestamps')
    follower.tracker.markItemDirty('item-1' as ItemId)
    expect(saveSpy).not.toHaveBeenCalled()

    // As the page being hidden does
    await follower.flushPendingSnapshots()
    await vi.advanceTimersByTimeAsync(0)

    expect(saveSpy).toHaveBeenCalledWith([['item-1', expect.objectContaining({ localModifiedAt: expect.any(Number) })]])
    expect(mockPutSnapshots).not.toHaveBeenCalled()
  })

  describe('Leadership Coordination and Follower Protection', () => {
    let followerManager: SnapshotManager

    beforeEach(() => {
      // Default creation without options starts with isLeader: false
      followerManager = createManager(context as any, lastModifiedStore)
    })

    it('defaults isLeader to false and exposes leader getter', () => {
      expect(isLeader(followerManager)).toBe(false)
    })

    it('prevents flushPendingSnapshots from uploading when not leader', async () => {
      followerManager.tracker.markItemDirty('follower-item-1' as ItemId)

      const result = await followerManager.flushPendingSnapshots()

      expect(result).toEqual({ persisted: 0, total: 0 })
      expect(mockPutSnapshots).not.toHaveBeenCalled()
    })

    it('does not schedule debounced push timers when marked dirty as follower', async () => {
      followerManager.tracker.markItemDirty('follower-item-1' as ItemId)

      // Advance timers beyond debounce and max wait
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000)

      expect(mockPutSnapshots).not.toHaveBeenCalled()
    })

    it('does not trigger push on online state change when not leader', async () => {
      followerManager.tracker.markItemDirty('follower-item-1' as ItemId)
      setOnline(followerManager, true)

      await vi.advanceTimersByTimeAsync(1000)
      expect(mockPutSnapshots).not.toHaveBeenCalled()
    })

    it('schedules debounced snapshot push when promoted to leader with dirty items', async () => {
      mockPutSnapshots.mockResolvedValue({
        success: true,
        persisted: 1,
      })

      followerManager.tracker.markItemDirty('follower-item-1' as ItemId)
      expect(mockPutSnapshots).not.toHaveBeenCalled()

      // Promoted to leader
      setLeader(followerManager, true)
      expect(isLeader(followerManager)).toBe(true)

      // Debounced push runs
      await vi.advanceTimersByTimeAsync(30_000)

      expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
      expect(mockPutSnapshots.mock.calls[0][0].snapshots[0].itemId).toBe('follower-item-1')
    })

    it('clears active debounce and retry timers when leadership is revoked', async () => {
      manager.tracker.markItemDirty('leader-item-1' as ItemId)

      // Leadership revoked before debounce timer fires
      setLeader(manager, false)
      expect(isLeader(manager)).toBe(false)

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
      expect(mockPutSnapshots).not.toHaveBeenCalled()
    })

    it('safely no-ops during simulated visibilitychange pushSnapshots on follower tab', async () => {
      // Simulate user editing in follower tab
      followerManager.tracker.markItemDirty('doc-edit-1' as ItemId)

      // Simulate tab visibility changing to hidden -> flushPendingSnapshots called
      const flushResult = await followerManager.flushPendingSnapshots()

      expect(flushResult).toEqual({ persisted: 0, total: 0 })
      expect(mockPutSnapshots).not.toHaveBeenCalled()
    })

    it('re-reads lastModifiedStore and restores un-snapshotted items to dirty queue upon promotion to leader', async () => {
      vi.spyOn(lastModifiedStore, 'loadTimestamps').mockResolvedValue([
        ['item-unpushed' as ItemId, { localModifiedAt: 5000, lastSnapshotAt: 2000 }],
        ['item-clean' as ItemId, { localModifiedAt: 3000, lastSnapshotAt: 3000 }],
      ])

      expect(followerManager.tracker.getDirtyItemIds()).toEqual([])

      await setLeader(followerManager, true)

      expect(followerManager.tracker.getDirtyItemIds()).toContain('item-unpushed')
      expect(followerManager.tracker.getDirtyItemIds()).not.toContain('item-clean')
    })

    it('pushes un-snapshotted items from previous leader after follower promotion', async () => {
      mockPutSnapshots.mockResolvedValue({
        success: true,
        persisted: 1,
        total: 1,
      })

      vi.spyOn(lastModifiedStore, 'loadTimestamps').mockResolvedValue([
        ['item-from-previous-leader' as ItemId, { localModifiedAt: 6000, lastSnapshotAt: 1000 }],
      ])

      await setLeader(followerManager, true)

      await vi.advanceTimersByTimeAsync(30_000)

      expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
      expect(mockPutSnapshots.mock.calls[0][0].snapshots[0].itemId).toBe('item-from-previous-leader')
    })

    it('merges follower local dirty items with un-snapshotted items from previous leader on promotion', async () => {
      mockPutSnapshots.mockResolvedValue({
        success: true,
        persisted: 2,
        total: 2,
      })

      followerManager.tracker.markItemDirty('follower-local-item' as ItemId)

      vi.spyOn(lastModifiedStore, 'loadTimestamps').mockResolvedValue([
        ['item-from-previous-leader' as ItemId, { localModifiedAt: 8000, lastSnapshotAt: 2000 }],
      ])

      await setLeader(followerManager, true)

      expect(followerManager.tracker.getDirtyItemIds()).toContain('follower-local-item')
      expect(followerManager.tracker.getDirtyItemIds()).toContain('item-from-previous-leader')

      await vi.advanceTimersByTimeAsync(30_000)

      expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
      const sentIds = mockPutSnapshots.mock.calls[0][0].snapshots.map((s: any) => s.itemId)
      expect(sentIds).toContain('follower-local-item')
      expect(sentIds).toContain('item-from-previous-leader')
    })

    it('does not schedule snapshot push upon promotion if all stored items are clean', async () => {
      vi.spyOn(lastModifiedStore, 'loadTimestamps').mockResolvedValue([
        ['item-clean' as ItemId, { localModifiedAt: 4000, lastSnapshotAt: 4000 }],
      ])

      await setLeader(followerManager, true)

      expect(followerManager.tracker.getDirtyItemIds()).toHaveLength(0)

      await vi.advanceTimersByTimeAsync(30_000)
      expect(mockPutSnapshots).not.toHaveBeenCalled()
    })

    it('does not schedule snapshot push if leadership is revoked while promotion audit is in flight', async () => {
      let resolveTimestamps: (val: any) => void
      const pendingLoad = new Promise(resolve => {
        resolveTimestamps = resolve
      })
      vi.spyOn(lastModifiedStore, 'loadTimestamps').mockReturnValue(pendingLoad as any)

      const promotionPromise = setLeader(followerManager, true)

      // Leadership revoked before load completes
      await setLeader(followerManager, false)
      expect(isLeader(followerManager)).toBe(false)

      resolveTimestamps!([
        ['item-unpushed' as ItemId, { localModifiedAt: 5000, lastSnapshotAt: 2000 }],
      ])
      await promotionPromise

      await vi.advanceTimersByTimeAsync(30_000)
      expect(mockPutSnapshots).not.toHaveBeenCalled()
    })
  })

  describe('In-flight push cancellation', () => {
    it('aborts in-flight snapshot push when leadership is revoked', async () => {
      let capturedSignal: AbortSignal | undefined
      mockPutSnapshots.mockImplementationOnce((_input, options) => {
        capturedSignal = options?.signal
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          })
        })
      })

      manager.tracker.markItemDirty('item-1' as ItemId)
      const pushPromise = manager.flushPendingSnapshots()

      await vi.advanceTimersByTimeAsync(0)
      expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
      expect(capturedSignal).toBeDefined()
      expect(capturedSignal?.aborted).toBe(false)

      await setLeader(manager, false)

      expect(capturedSignal?.aborted).toBe(true)
      const result = await pushPromise
      expect(result.persisted).toBe(0)
    })

    it('aborts in-flight snapshot push when going offline', async () => {
      let capturedSignal: AbortSignal | undefined
      mockPutSnapshots.mockImplementationOnce((_input, options) => {
        capturedSignal = options?.signal
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          })
        })
      })

      manager.tracker.markItemDirty('item-1' as ItemId)
      const pushPromise = manager.flushPendingSnapshots()

      await vi.advanceTimersByTimeAsync(0)
      expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
      expect(capturedSignal?.aborted).toBe(false)

      setOnline(manager, false)

      expect(capturedSignal?.aborted).toBe(true)
      const result = await pushPromise
      expect(result.persisted).toBe(0)
    })

    it('aborts in-flight snapshot push when shutdown occurs', async () => {
      let capturedSignal: AbortSignal | undefined
      mockPutSnapshots.mockImplementationOnce((_input, options) => {
        capturedSignal = options?.signal
        return new Promise(resolve => {
          options?.signal?.addEventListener('abort', () => {
            resolve({ success: false, persisted: 0, total: 1 })
          })
        })
      })

      manager.tracker.markItemDirty('item-1' as ItemId)
      const pushPromise = manager.flushPendingSnapshots()

      await vi.advanceTimersByTimeAsync(0)
      expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
      expect(capturedSignal?.aborted).toBe(false)

      await shutDown(manager)

      expect(capturedSignal?.aborted).toBe(true)
      const result = await pushPromise
      expect(result.persisted).toBe(0)
    })
  })
})
