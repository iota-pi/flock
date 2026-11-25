import type { ItemId } from '@vault/shared'
import { SnapshotManager, type SnapshotManagerOptions } from './SnapshotManager'
import { SyncSessionState } from './SyncSessionState'
import { ItemSyncState } from './ItemSyncState'
import { RecoveryManager } from './RecoveryManager'
import { passthroughCodec, type DocCodec } from './domain'
import { SnapshotBuilder } from './SnapshotBuilder'
import type { Repo } from '@automerge/automerge-repo/slim'
import { SyncApiClient } from './SyncApiClient'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'
import { setApiAuthToken } from '../keys/runtime'
import { createMockKeyProvider, createMockVault, noLogCoverage, spyOnVaultTrpc, createMemoryItemRecords } from './__test__/testUtils'
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
const pollControllers = new WeakMap<SnapshotManager, AbortController>()

/** Runs one poll's snapshot phase, as the orchestrator does, swallowing its failure as a poll would */
async function poll(target: SnapshotManager): Promise<void> {
  const controller = new AbortController()
  pollControllers.set(target, controller)
  try {
    await target.pushDue(controller.signal)
  } catch {
    // The poll reports a failure
  }
}

/** Aborts the poll in flight, as the orchestrator does when leadership or the connection goes */
function abortPoll(target: SnapshotManager): void {
  pollControllers.get(target)?.abort()
}

type ItemRecordsDb = ReturnType<typeof createMemoryItemRecords>['db']

/** A manager with its own session state, a leader's when `isLeader` is set */
function createManager(
  context: Omit<ConstructorParameters<typeof SnapshotManager>[0], 'session' | 'state' | 'builder' | 'runPollNow'> & {
    repo: Repo
    keys: KeyProvider
    codec?: DocCodec
  },
  db: ItemRecordsDb,
  options: SnapshotManagerOptions & { isLeader?: boolean } = {},
): SnapshotManager {
  const { isLeader, ...managerOptions } = options
  const { repo, keys, codec = passthroughCodec, ...deps } = context
  const session = new SyncSessionState({ isLeader })
  const builder = new SnapshotBuilder(repo, keys, codec, noLogCoverage)
  const created: SnapshotManager = new SnapshotManager(
    { ...deps, session, state: new ItemSyncState({ db, session }), builder, runPollNow: () => poll(created) },
    managerOptions,
  )
  sessions.set(created, session)
  return created
}

/** Changes the session's leadership and tells the manager, loading the records on promotion as the context does */
async function setLeader(target: SnapshotManager, isLeader: boolean): Promise<void> {
  if (sessions.get(target)!.setLeader(isLeader)) {
    target.onLeaderChange()
    if (isLeader) await target.load()
  }
}

/** Marks the session shut down and stops the manager and then its records, as the context does */
async function shutDown(target: SnapshotManager, options?: { clearLocalData?: boolean }): Promise<void> {
  sessions.get(target)!.markShutdown()
  await target.shutdown()
  await target.state.shutdown(options)
}

function isLeader(target: SnapshotManager): boolean {
  return sessions.get(target)!.isLeader
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
  let onDueChanged: ReturnType<typeof vi.fn<() => void>>
  let context: {
    accountId: string | null
    repo: any
    pushToLog: any
    onSnapshotStored: any
    eventHub: any
    recoveryManager: RecoveryManager
    apiClient: SyncApiClient
    keys: KeyProvider
    onDueChanged: () => void
    isCaughtUp: () => boolean
    hasPendingMarks: () => Promise<boolean>
  }
  let caughtUp: boolean
  let pendingMarks: boolean
  let records: ReturnType<typeof createMemoryItemRecords>

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
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
    onDueChanged = vi.fn()
    caughtUp = true
    pendingMarks = false

    context = {
      accountId: 'test-account',
      repo: mockRepo,
      pushToLog: vi.fn().mockResolvedValue(undefined),
      onSnapshotStored: vi.fn(),
      eventHub: mockEventHub,
      recoveryManager: new RecoveryManager({ accountId: 'test-account', eventHub: mockEventHub as any }),
      apiClient: new SyncApiClient(),
      keys,
      onDueChanged: () => onDueChanged(),
      isCaughtUp: () => caughtUp,
      hasPendingMarks: async () => pendingMarks,
    }

    records = createMemoryItemRecords()
    manager = createManager(context as any, records.db, { isLeader: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** Moves the clock on, past the snapshot debounce by default */
  function elapse(ms: number = SYNC_TIMEOUTS.snapshotDebounce): void {
    vi.setSystemTime(Date.now() + ms)
  }

  it('tells the orchestrator when an edit makes snapshots due', () => {
    manager.schedule.markItemDirty('item-1' as ItemId)

    expect(onDueChanged).toHaveBeenCalledTimes(1)
  })

  it('uploads at a poll once the debounce has passed, and not before', async () => {
    mockPutSnapshots.mockResolvedValue({ success: true, persisted: 1 })
    manager.schedule.markItemDirty('item-1' as ItemId)

    await poll(manager)
    expect(mockPutSnapshots).not.toHaveBeenCalled()

    elapse()
    await poll(manager)
    expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
  })

  it('uploads nothing until the device has caught up, keeping what is due for the poll that has', async () => {
    mockPutSnapshots.mockResolvedValue({ success: true, persisted: 1 })
    manager.schedule.markItemDirty('item-1' as ItemId)
    manager.schedule.requestNow()
    caughtUp = false

    await expect(poll(manager)).resolves.toBeUndefined()
    expect(mockPutSnapshots).not.toHaveBeenCalled()

    caughtUp = true
    pendingMarks = false
    await poll(manager)
    expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
  })

  it('flushes by running a poll with every snapshot due now, and reports what it uploaded', async () => {
    mockPutSnapshots.mockResolvedValue({ success: true, persisted: 1 })
    manager.schedule.markItemDirty('item-1' as ItemId)

    const result = await manager.flushPendingSnapshots()

    expect(result).toEqual({ persisted: 1, total: 1 })
    expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
    expect(manager.schedule.dirtyCount).toBe(0)
  })

  it('reports nothing uploaded when the flush poll failed', async () => {
    mockPutSnapshots.mockRejectedValue(new Error('Network disconnected'))
    manager.schedule.markItemDirty('item-1' as ItemId)

    const result = await manager.flushPendingSnapshots()

    expect(result).toEqual({ persisted: 0, total: 0 })
    expect(manager.schedule.getDirtyItemIds()).toContain('item-1')
  })

  it('does not run a poll to flush when nothing is dirty', async () => {
    const runPollNow = vi.fn().mockResolvedValue(undefined)
    const idle = new SnapshotManager({
      ...context as any,
      session: new SyncSessionState({ isLeader: true }),
      state: new ItemSyncState({ db: records.db, session: new SyncSessionState() }),
      builder: new SnapshotBuilder(mockRepo, keys, passthroughCodec, noLogCoverage),
      runPollNow,
    })

    await expect(idle.flushPendingSnapshots()).resolves.toEqual({ persisted: 0, total: 0 })
    expect(runPollNow).not.toHaveBeenCalled()
  })

  it('runs a poll to flush when nothing is dirty yet but items have pending marks', async () => {
    pendingMarks = true
    let dueInPoll = false
    // eslint-disable-next-line prefer-const -- read by the poll, before it's assigned below
    let leader: SnapshotManager
    const runPollNow = vi.fn(async () => {
      // The poll's log push is acknowledged, which marks the item dirty
      leader.schedule.markItemDirty('item-1' as ItemId)
      dueInPoll = leader.schedule.isDue()
    })
    const session = new SyncSessionState({ isLeader: true })
    leader = new SnapshotManager({
      ...context as any,
      session,
      state: new ItemSyncState({ db: records.db, session }),
      builder: new SnapshotBuilder(mockRepo, keys, passthroughCodec, noLogCoverage),
      runPollNow: () => runPollNow(),
    })

    await leader.flushPendingSnapshots()

    expect(runPollNow).toHaveBeenCalledTimes(1)
    expect(dueInPoll).toBe(true)
  })

  it("doesn't leave a flush's request due when the poll made nothing dirty", async () => {
    pendingMarks = true
    const runPollNow = vi.fn().mockResolvedValue(undefined)
    const session = new SyncSessionState({ isLeader: true })
    const leader = new SnapshotManager({
      ...context as any,
      session,
      state: new ItemSyncState({ db: records.db, session }),
      builder: new SnapshotBuilder(mockRepo, keys, passthroughCodec, noLogCoverage),
      runPollNow,
    })

    await leader.flushPendingSnapshots()
    leader.schedule.markItemDirty('item-1' as ItemId)

    expect(runPollNow).toHaveBeenCalledTimes(1)
    expect(leader.schedule.isDue()).toBe(false)
  })

  it('saves pending dirty flags at once when flushed, even in a follower tab', async () => {
    const follower = createManager(context as any, records.db, { isLeader: false })
    follower.schedule.markItemDirty('item-1' as ItemId)
    expect(records.db.update).not.toHaveBeenCalled()

    // As the page being hidden does
    await follower.flushPendingSnapshots()
    await vi.advanceTimersByTimeAsync(0)

    expect(records.get('item-1')).toEqual({ itemId: 'item-1', dirty: true })
    expect(mockPutSnapshots).not.toHaveBeenCalled()
  })

  describe('Leadership Coordination and Follower Protection', () => {
    let followerManager: SnapshotManager

    beforeEach(() => {
      // Default creation without options starts with isLeader: false
      followerManager = createManager(context as any, records.db)
    })

    it('defaults isLeader to false and exposes leader getter', () => {
      expect(isLeader(followerManager)).toBe(false)
    })

    it('prevents flushPendingSnapshots from uploading when not leader', async () => {
      followerManager.schedule.markItemDirty('follower-item-1' as ItemId)

      const result = await followerManager.flushPendingSnapshots()

      expect(result).toEqual({ persisted: 0, total: 0 })
      expect(mockPutSnapshots).not.toHaveBeenCalled()
    })

    it('does not upload from a follower however long its items have been dirty', async () => {
      followerManager.schedule.markItemDirty('follower-item-1' as ItemId)

      elapse(2 * SYNC_TIMEOUTS.snapshotMaxWait)
      await poll(followerManager)

      expect(mockPutSnapshots).not.toHaveBeenCalled()
    })

    it('uploads after the debounce when promoted to leader with dirty items', async () => {
      mockPutSnapshots.mockResolvedValue({
        success: true,
        persisted: 1,
      })

      followerManager.schedule.markItemDirty('follower-item-1' as ItemId)
      expect(mockPutSnapshots).not.toHaveBeenCalled()

      // Promoted to leader
      await setLeader(followerManager, true)
      expect(isLeader(followerManager)).toBe(true)

      elapse()
      await poll(followerManager)

      expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
      expect(mockPutSnapshots.mock.calls[0][0].snapshots[0].itemId).toBe('follower-item-1')
    })

    it('drops the due time when leadership is revoked', async () => {
      manager.schedule.markItemDirty('leader-item-1' as ItemId)

      await setLeader(manager, false)
      expect(isLeader(manager)).toBe(false)

      expect(manager.schedule.nextDueAt).toBeUndefined()
      elapse(2 * SYNC_TIMEOUTS.snapshotMaxWait)
      await poll(manager)
      expect(mockPutSnapshots).not.toHaveBeenCalled()
    })

    it('re-reads the item records and restores flagged items to dirty queue upon promotion to leader', async () => {
      records.records.set('item-unpushed' as ItemId, { itemId: 'item-unpushed' as ItemId, dirty: true })
      records.records.set('item-clean' as ItemId, { itemId: 'item-clean' as ItemId, baseVersion: 3 })

      expect(followerManager.schedule.getDirtyItemIds()).toEqual([])

      await setLeader(followerManager, true)

      expect(followerManager.schedule.getDirtyItemIds()).toContain('item-unpushed')
      expect(followerManager.schedule.getDirtyItemIds()).not.toContain('item-clean')
    })

    it('pushes un-snapshotted items from previous leader after follower promotion', async () => {
      mockPutSnapshots.mockResolvedValue({
        success: true,
        persisted: 1,
        total: 1,
      })

      records.records.set('item-from-previous-leader' as ItemId, { itemId: 'item-from-previous-leader' as ItemId, dirty: true })

      await setLeader(followerManager, true)

      elapse()
      await poll(followerManager)

      expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
      expect(mockPutSnapshots.mock.calls[0][0].snapshots[0].itemId).toBe('item-from-previous-leader')
    })

    it('merges follower local dirty items with un-snapshotted items from previous leader on promotion', async () => {
      mockPutSnapshots.mockResolvedValue({
        success: true,
        persisted: 2,
        total: 2,
      })

      followerManager.schedule.markItemDirty('follower-local-item' as ItemId)

      records.records.set('item-from-previous-leader' as ItemId, { itemId: 'item-from-previous-leader' as ItemId, dirty: true })

      await setLeader(followerManager, true)

      expect(followerManager.schedule.getDirtyItemIds()).toContain('follower-local-item')
      expect(followerManager.schedule.getDirtyItemIds()).toContain('item-from-previous-leader')

      elapse()
      await poll(followerManager)

      expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
      const sentIds = mockPutSnapshots.mock.calls[0][0].snapshots.map((s: any) => s.itemId)
      expect(sentIds).toContain('follower-local-item')
      expect(sentIds).toContain('item-from-previous-leader')
    })

    it('has nothing due upon promotion if all stored items are clean', async () => {
      records.records.set('item-clean' as ItemId, { itemId: 'item-clean' as ItemId, baseVersion: 4 })

      await setLeader(followerManager, true)

      expect(followerManager.schedule.getDirtyItemIds()).toHaveLength(0)
      expect(followerManager.schedule.nextDueAt).toBeUndefined()
    })

    it('does not upload if leadership is revoked while promotion audit is in flight', async () => {
      let resolveRecords: (val: any) => void
      const pendingLoad = new Promise(resolve => {
        resolveRecords = resolve
      })
      records.db.getAll.mockReturnValueOnce(pendingLoad as any)

      const promotionPromise = setLeader(followerManager, true)

      // Leadership revoked before load completes
      await setLeader(followerManager, false)
      expect(isLeader(followerManager)).toBe(false)

      resolveRecords!([{ itemId: 'item-unpushed', dirty: true }])
      await promotionPromise

      elapse()
      await poll(followerManager)
      expect(mockPutSnapshots).not.toHaveBeenCalled()
    })
  })

  describe('In-flight push cancellation', () => {
    it('aborts the upload in flight with the poll, leaving the item dirty', async () => {
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

      manager.schedule.markItemDirty('item-1' as ItemId)
      const flush = manager.flushPendingSnapshots()

      await vi.advanceTimersByTimeAsync(0)
      expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
      expect(capturedSignal?.aborted).toBe(false)

      abortPoll(manager)

      expect(capturedSignal?.aborted).toBe(true)
      await expect(flush).resolves.toEqual({ persisted: 0, total: 0 })
      expect(manager.schedule.getDirtyItemIds()).toContain('item-1')
    })

    it('stops cleanly once polling has stopped', async () => {
      manager.schedule.markItemDirty('item-1' as ItemId)

      await shutDown(manager)

      expect(manager.schedule.dirtyCount).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    })
  })
})
