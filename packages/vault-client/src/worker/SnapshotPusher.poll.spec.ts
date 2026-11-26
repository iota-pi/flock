import type { ItemId } from '@vault/shared'
import { SnapshotPusher, type SnapshotPusherOptions } from './SnapshotPusher'
import { SnapshotSchedule } from './SnapshotSchedule'
import { queueFlaggedItems } from './startupAudit'
import { SyncSessionState } from './SyncSessionState'
import { ItemSyncState } from './ItemSyncState'
import { RecoveryManager } from './RecoveryManager'
import { passthroughCodec, type DocCodec } from './domain'
import { SnapshotBuilder } from './SnapshotBuilder'
import type { Repo } from '@automerge/automerge-repo/slim'
import { SyncApiClient } from './SyncApiClient'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'
import { setApiAuthToken } from '../keys/runtime'
import { createMockKeyProvider, createMockVault, docLookupFromRepo, noLogCoverage, spyOnVaultTrpc, createMemoryItemRecords } from './__test__/testUtils'
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

/** A session's snapshot components, wired as the context wires them */
interface Snapshots {
  session: SyncSessionState
  state: ItemSyncState
  schedule: SnapshotSchedule
  pusher: SnapshotPusher
  /** Loads the item records and runs the startup audit, as the context does at start */
  load: () => Promise<void>
}

const pollControllers = new WeakMap<Snapshots, AbortController>()

/** Runs one poll's snapshot phase, as the orchestrator does, swallowing its failure as a poll would */
async function poll(target: Snapshots): Promise<void> {
  const controller = new AbortController()
  pollControllers.set(target, controller)
  try {
    await target.pusher.pushDue(controller.signal)
  } catch {
    // The poll reports a failure
  }
}

/** Aborts the poll in flight, as the orchestrator does when the connection goes */
function abortPoll(target: Snapshots): void {
  pollControllers.get(target)?.abort()
}

type ItemRecordsDb = ReturnType<typeof createMemoryItemRecords>['db']

type PusherContext = Omit<SnapshotPusherOptions, 'session' | 'schedule' | 'state' | 'builder' | 'runPollNow'> & {
  repo: Repo
  keys: KeyProvider
  codec?: DocCodec
  onDueChanged?: () => void
}

/** A schedule and pusher with their own session state */
function createSnapshots(
  context: PusherContext,
  db: ItemRecordsDb,
  options: { runPollNow?: (target: Snapshots) => Promise<void> } = {},
): Snapshots {
  const { repo, keys, codec = passthroughCodec, onDueChanged, ...deps } = context
  const session = new SyncSessionState()
  const state = new ItemSyncState({ db, session })
  const schedule = new SnapshotSchedule({ state, session, onDueChanged })
  const runPollNow = options.runPollNow ?? poll
  const created: Snapshots = {
    session,
    state,
    schedule,
    pusher: new SnapshotPusher({
      ...deps,
      session,
      schedule,
      state,
      builder: new SnapshotBuilder(docLookupFromRepo(repo), keys, codec, noLogCoverage),
      runPollNow: () => runPollNow(created),
    }),
    load: async () => {
      const flagged = await state.load()
      await queueFlaggedItems(flagged, { recoveryManager: deps.recoveryManager, schedule, session })
    },
  }
  return created
}

/** Marks the session shut down and stops the pusher and then the records, as the context does */
async function shutDown(target: Snapshots, options?: { clearLocalData?: boolean }): Promise<void> {
  target.session.markShutdown()
  target.pusher.shutdown()
  await target.state.shutdown(options)
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

describe('SnapshotPusher in a poll', () => {
  let snapshots: Snapshots
  let mockRepo: any
  let mockHandle: any
  let mockEventHub: { emit: ReturnType<typeof vi.fn> }
  let onDueChanged: ReturnType<typeof vi.fn<() => void>>
  let context: {
    accountId: string | null
    repo: any
    pushToLog: any
    storeDocs: any
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
      storeDocs: vi.fn().mockResolvedValue(undefined),
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
    snapshots = createSnapshots(context as any, records.db)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** Moves the clock on, past the snapshot debounce by default */
  function elapse(ms: number = SYNC_TIMEOUTS.snapshotDebounce): void {
    vi.setSystemTime(Date.now() + ms)
  }

  it('tells the orchestrator when an edit makes snapshots due', () => {
    snapshots.schedule.markItemDirty('item-1' as ItemId)

    expect(onDueChanged).toHaveBeenCalledTimes(1)
  })

  it('uploads at a poll once the debounce has passed, and not before', async () => {
    mockPutSnapshots.mockResolvedValue({ success: true, persisted: 1 })
    snapshots.schedule.markItemDirty('item-1' as ItemId)

    await poll(snapshots)
    expect(mockPutSnapshots).not.toHaveBeenCalled()

    elapse()
    await poll(snapshots)
    expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
  })

  it('uploads nothing until the device has caught up, keeping what is due for the poll that has', async () => {
    mockPutSnapshots.mockResolvedValue({ success: true, persisted: 1 })
    snapshots.schedule.markItemDirty('item-1' as ItemId)
    snapshots.schedule.requestNow({ pastQuota: true })
    caughtUp = false

    await expect(poll(snapshots)).resolves.toBeUndefined()
    expect(mockPutSnapshots).not.toHaveBeenCalled()

    caughtUp = true
    pendingMarks = false
    await poll(snapshots)
    expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
  })

  it('flushes by running a poll with every snapshot due now, and reports what it uploaded', async () => {
    mockPutSnapshots.mockResolvedValue({ success: true, persisted: 1 })
    snapshots.schedule.markItemDirty('item-1' as ItemId)

    const result = await snapshots.pusher.flushPendingSnapshots()

    expect(result).toEqual({ persisted: 1, total: 1 })
    expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
    expect(snapshots.state.dirtyCount).toBe(0)
  })

  it('reports nothing uploaded when the flush poll failed', async () => {
    mockPutSnapshots.mockRejectedValue(new TypeError('Failed to fetch'))
    snapshots.schedule.markItemDirty('item-1' as ItemId)

    const result = await snapshots.pusher.flushPendingSnapshots()

    expect(result).toEqual({ persisted: 0, total: 0 })
    expect(snapshots.state.listDirty()).toContain('item-1')
  })

  it('does not run a poll to flush when nothing is dirty', async () => {
    const runPollNow = vi.fn().mockResolvedValue(undefined)
    const idle = createSnapshots(context as any, records.db, { runPollNow })

    await expect(idle.pusher.flushPendingSnapshots()).resolves.toEqual({ persisted: 0, total: 0 })
    expect(runPollNow).not.toHaveBeenCalled()
  })

  it('runs a poll to flush when nothing is dirty yet but items have pending marks', async () => {
    pendingMarks = true
    let dueInPoll = false
    const runPollNow = vi.fn(async (target: Snapshots) => {
      // The poll's log push is acknowledged, which marks the item dirty
      target.schedule.markItemDirty('item-1' as ItemId)
      dueInPoll = target.schedule.isDue()
    })
    const target = createSnapshots(context as any, records.db, { runPollNow })

    await target.pusher.flushPendingSnapshots()

    expect(runPollNow).toHaveBeenCalledTimes(1)
    expect(dueInPoll).toBe(true)
  })

  it("doesn't leave a flush's request due when the poll made nothing dirty", async () => {
    pendingMarks = true
    const runPollNow = vi.fn().mockResolvedValue(undefined)
    const target = createSnapshots(context as any, records.db, { runPollNow })

    await target.pusher.flushPendingSnapshots()
    target.schedule.markItemDirty('item-1' as ItemId)

    expect(runPollNow).toHaveBeenCalledTimes(1)
    expect(target.schedule.isDue()).toBe(false)
  })

  it('saves pending dirty flags at once when flushed, even offline', async () => {
    snapshots.session.setOnline(false)
    snapshots.schedule.markItemDirty('item-1' as ItemId)
    expect(records.db.update).not.toHaveBeenCalled()

    // As the page being hidden does
    await snapshots.pusher.flushPendingSnapshots()
    await vi.advanceTimersByTimeAsync(0)

    expect(records.get('item-1')).toEqual({ itemId: 'item-1', dirty: true })
    expect(mockPutSnapshots).not.toHaveBeenCalled()
  })

  describe('startup audit', () => {
    let fresh: Snapshots

    beforeEach(() => {
      fresh = createSnapshots(context as any, records.db)
    })

    it('reads the item records and restores flagged items to the dirty queue', async () => {
      records.records.set('item-unpushed' as ItemId, { itemId: 'item-unpushed' as ItemId, dirty: true })
      records.records.set('item-clean' as ItemId, { itemId: 'item-clean' as ItemId, baseVersion: 3 })

      await fresh.load()

      expect(fresh.state.listDirty()).toContain('item-unpushed')
      expect(fresh.state.listDirty()).not.toContain('item-clean')
    })

    it('pushes items an earlier session left un-snapshotted', async () => {
      mockPutSnapshots.mockResolvedValue({
        success: true,
        persisted: 1,
        total: 1,
      })
      records.records.set('item-from-earlier' as ItemId, { itemId: 'item-from-earlier' as ItemId, dirty: true })

      await fresh.load()
      elapse()
      await poll(fresh)

      expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
      expect(mockPutSnapshots.mock.calls[0][0].snapshots[0].itemId).toBe('item-from-earlier')
    })

    it('has nothing due if all stored items are clean', async () => {
      records.records.set('item-clean' as ItemId, { itemId: 'item-clean' as ItemId, baseVersion: 4 })

      await fresh.load()

      expect(fresh.state.listDirty()).toHaveLength(0)
      expect(fresh.schedule.nextDueAt).toBeUndefined()
    })

    it('does not upload once the session stopped while the audit was in flight', async () => {
      let resolveRecords: (val: any) => void
      const pendingLoad = new Promise(resolve => {
        resolveRecords = resolve
      })
      records.db.getAll.mockReturnValueOnce(pendingLoad as any)

      const load = fresh.load()
      fresh.session.markShutdown()
      resolveRecords!([{ itemId: 'item-unpushed', dirty: true }])
      await load

      elapse()
      await poll(fresh)
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

      snapshots.schedule.markItemDirty('item-1' as ItemId)
      const flush = snapshots.pusher.flushPendingSnapshots()

      await vi.advanceTimersByTimeAsync(0)
      expect(mockPutSnapshots).toHaveBeenCalledTimes(1)
      expect(capturedSignal?.aborted).toBe(false)

      abortPoll(snapshots)

      expect(capturedSignal?.aborted).toBe(true)
      await expect(flush).resolves.toEqual({ persisted: 0, total: 0 })
      expect(snapshots.state.listDirty()).toContain('item-1')
    })

    it('stops cleanly once polling has stopped', async () => {
      snapshots.schedule.markItemDirty('item-1' as ItemId)

      await shutDown(snapshots)

      expect(snapshots.state.dirtyCount).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    })
  })
})
