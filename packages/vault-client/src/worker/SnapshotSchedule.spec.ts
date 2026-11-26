import { SnapshotSchedule } from './SnapshotSchedule'
import { ItemSyncState } from './ItemSyncState'
import { createMemoryItemRecords } from './__test__/testUtils'
import { type ItemId, MAX_ITEM_SIZE_KB } from '@vault/shared'
import { SyncSessionState } from './SyncSessionState'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'

describe('SnapshotSchedule', () => {
  let tracker: SnapshotSchedule
  let state: ItemSyncState
  let session: SyncSessionState
  let store: ReturnType<typeof createMemoryItemRecords>
  let mockRecoveryManager: any
  let onDueChanged: ReturnType<typeof vi.fn<() => void>>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    onDueChanged = vi.fn<() => void>()
    store = createMemoryItemRecords()
    mockRecoveryManager = {
      listRecoveryItems: vi.fn().mockResolvedValue([]),
    }

    session = new SyncSessionState()
    state = new ItemSyncState({ db: store.db, session })
    tracker = new SnapshotSchedule({
      state,
      recoveryManager: mockRecoveryManager,
      debounceDelayMs: 1000,
      maxWaitMs: 5000,
      session,
      onDueChanged: () => onDueChanged(),
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** Marks the session shut down and stops the schedule and then the state, as the context does */
  async function shutDown(options?: { clearLocalData?: boolean }): Promise<void> {
    session.markShutdown()
    await tracker.shutdown()
    await state.shutdown(options)
  }

  /** Loads the records and runs the audit, as the context does at start and on promotion */
  function load(): Promise<void> {
    return tracker.load()
  }

  it('marks items dirty with monotonic tick, due once the debounce expires', async () => {
    tracker.markItemDirty('item-1' as ItemId)
    expect(state.getDirtyTick('item-1' as ItemId)).toBe(1)
    expect(state.dirtyCount).toBe(1)

    tracker.markItemDirty('item-2' as ItemId)
    expect(state.getDirtyTick('item-2' as ItemId)).toBe(2)
    expect(state.dirtyCount).toBe(2)

    expect(tracker.nextDueAt).toBe(1000)
    expect(tracker.isDue(999)).toBe(false)
    expect(tracker.isDue(1000)).toBe(true)
  })

  it('tells the orchestrator each time an edit changes when uploads are due', () => {
    tracker.markItemDirty('item-1' as ItemId)
    tracker.markItemDirty('item-2' as ItemId, 0)

    expect(onDueChanged).toHaveBeenCalledTimes(2)
  })

  it('is due at maxWait even if the debounce is continuously reset', async () => {
    tracker.markItemDirty('item-1' as ItemId)

    vi.setSystemTime(800)
    tracker.markItemDirty('item-2' as ItemId)
    vi.setSystemTime(1600)
    tracker.markItemDirty('item-3' as ItemId)
    vi.setSystemTime(2400)
    tracker.markItemDirty('item-3' as ItemId)
    vi.setSystemTime(3200)
    tracker.markItemDirty('item-3' as ItemId)
    vi.setSystemTime(4000)
    tracker.markItemDirty('item-3' as ItemId)
    expect(tracker.isDue()).toBe(false)

    // 5000ms from the first edit
    expect(tracker.nextDueAt).toBe(5000)
    vi.setSystemTime(5000)
    expect(tracker.isDue()).toBe(true)
  })

  it('keeps a requested delay however later edits put the debounce off', () => {
    tracker.markItemDirty('item-1' as ItemId, 200)
    tracker.markItemDirty('item-2' as ItemId)

    expect(tracker.nextDueAt).toBe(200)
  })

  it('is not due with no dirty items', () => {
    tracker.markItemDirty('item-1' as ItemId, 0)
    tracker.deleteDirtyItem('item-1' as ItemId)

    expect(tracker.nextDueAt).toBeUndefined()
    expect(tracker.isDue()).toBe(false)
  })

  it('makes everything due now when asked to', () => {
    tracker.markItemDirty('item-1' as ItemId)
    vi.setSystemTime(100)

    tracker.requestNow()

    expect(tracker.nextDueAt).toBe(100)
    expect(tracker.isDue()).toBe(true)
  })

  it('stops being due as an upload takes the items', () => {
    tracker.markItemDirty('item-1' as ItemId, 0)

    tracker.clearDue()

    expect(tracker.isDue()).toBe(false)
    expect(tracker.nextDueAt).toBeUndefined()
    expect(state.dirtyCount).toBe(1)
  })

  describe('after a failed upload', () => {
    beforeEach(() => {
      tracker.markItemDirty('item-1' as ItemId, 0)
      tracker.clearDue()
      tracker.retryNextPoll()
    })

    // A retry waits for the poll's own cadence or backoff, so a failing upload can't loop polls
    it('is due at the next poll without bringing one forward', () => {
      expect(tracker.isDue()).toBe(true)
      expect(tracker.nextDueAt).toBeUndefined()
    })

    it('brings a poll forward again for a new edit', () => {
      tracker.markItemDirty('item-2' as ItemId)

      expect(tracker.nextDueAt).toBe(1000)
    })

    it('stops retrying once an upload takes the items again', () => {
      tracker.clearDue()

      expect(tracker.isDue()).toBe(false)
    })
  })

  describe('after the server turned uploads away for the quota', () => {
    beforeEach(() => {
      tracker.markItemDirty('item-1' as ItemId, 0)
      tracker.clearDue()
      tracker.deferUntil(10_000)
    })

    it('is not due before the deferral ends, then due at the next poll', () => {
      expect(tracker.isDue(9_999)).toBe(false)
      expect(tracker.isDue(10_000)).toBe(true)
      expect(tracker.nextDueAt).toBeUndefined()
    })

    it('makes a new edit due no sooner than the deferral ends', () => {
      tracker.markItemDirty('item-2' as ItemId, 0)

      expect(tracker.nextDueAt).toBe(10_000)
      expect(tracker.isDue(5_000)).toBe(false)
    })

    it('is due at once when asked to', () => {
      tracker.requestNow()

      expect(tracker.isDue(0)).toBe(true)
    })

    it('reports the deferral until it ends, for the rewrite phase', () => {
      expect(tracker.isDeferred(9_999)).toBe(true)
      expect(tracker.isDeferred(10_000)).toBe(false)
    })

    it('ends the deferral when it is lifted, leaving the items to retry at the next poll', () => {
      tracker.liftDeferral()

      expect(tracker.isDeferred(0)).toBe(false)
      expect(tracker.isDue(0)).toBe(true)
    })
  })

  describe('default debounce and max wait', () => {
    beforeEach(() => {
      tracker = new SnapshotSchedule({
        state,
        recoveryManager: mockRecoveryManager,
        session,
      })
    })

    it('is due a debounce after an item is marked dirty', () => {
      tracker.markItemDirty('item-1' as ItemId)

      expect(tracker.nextDueAt).toBe(SYNC_TIMEOUTS.snapshotDebounce)
    })

    it('puts the debounce off when another item is marked dirty before it ends', () => {
      const secondEditAt = SYNC_TIMEOUTS.snapshotDebounce / 2
      tracker.markItemDirty('item-1' as ItemId)
      vi.setSystemTime(secondEditAt)
      tracker.markItemDirty('item-2' as ItemId)

      expect(tracker.nextDueAt).toBe(secondEditAt + SYNC_TIMEOUTS.snapshotDebounce)
    })

    it('is due after the max wait even if continuous changes keep putting the debounce off', () => {
      const editInterval = SYNC_TIMEOUTS.snapshotDebounce / 2
      for (let editAt = 0; editAt < SYNC_TIMEOUTS.snapshotMaxWait; editAt += editInterval) {
        vi.setSystemTime(editAt)
        tracker.markItemDirty('item-1' as ItemId)
      }

      expect(tracker.nextDueAt).toBe(SYNC_TIMEOUTS.snapshotMaxWait)
    })

    it('makes items an earlier session left dirty due soon after startup, however later edits come', async () => {
      store.records.set('item-flagged' as ItemId, { itemId: 'item-flagged' as ItemId, dirty: true })
      await load()
      expect(tracker.nextDueAt).toBe(SYNC_TIMEOUTS.restoredSnapshotDelay)

      vi.setSystemTime(SYNC_TIMEOUTS.restoredSnapshotDelay / 2)
      tracker.markItemDirty('item-1' as ItemId)

      expect(tracker.nextDueAt).toBe(SYNC_TIMEOUTS.restoredSnapshotDelay)
    })

    it('markItemDirty respects custom debounce delay (e.g. 2000ms)', () => {
      tracker.markItemDirty('item-1' as ItemId, 2000)

      expect(tracker.isDue(1999)).toBe(false)
      expect(tracker.isDue(2000)).toBe(true)
    })
  })


  it('flags dirty items in their records, once the save debounce has passed', async () => {
    tracker.markItemDirty('item-1' as ItemId)
    expect(store.db.update).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1000)
    expect(store.get('item-1')).toEqual({ itemId: 'item-1', dirty: true })
  })

  it('saves within maxWait while edits keep coming', async () => {
    for (let elapsed = 0; elapsed < 5000; elapsed += 500) {
      tracker.markItemDirty('item-1' as ItemId)
      await vi.advanceTimersByTimeAsync(500)
    }
    expect(store.db.update).toHaveBeenCalled()
  })

  it('performs startup audit, restoring flagged items and skipping quarantined ones', async () => {
    store.records.set('item-flagged' as ItemId, { itemId: 'item-flagged' as ItemId, dirty: true })
    store.records.set('item-synced' as ItemId, { itemId: 'item-synced' as ItemId, baseVersion: 2 })
    store.records.set('item-quarantined' as ItemId, { itemId: 'item-quarantined' as ItemId, dirty: true })
    store.records.set('item-oversized' as ItemId, { itemId: 'item-oversized' as ItemId, snapshotOnly: true })

    mockRecoveryManager.listRecoveryItems.mockResolvedValue([
      { itemId: 'item-quarantined', reason: 'Decryption failed', kind: 'pullDecryption' },
      { itemId: 'item-oversized', reason: `Snapshot size exceeds ${MAX_ITEM_SIZE_KB} KB limit`, kind: 'oversized' },
    ])

    await load()

    expect(state.listDirty()).toEqual(['item-flagged'])
    expect(state.getBaseVersion('item-synced' as ItemId)).toBe(2)

    // The restored items go up after the restored delay, capped at this tracker's 1s debounce
    expect(tracker.nextDueAt).toBe(Date.now() + 1000)
    expect(onDueChanged).toHaveBeenCalled()
  })

  it('re-queues a snapshot-only item after a reload, writing its dirty flag only where it lacks one', async () => {
    store.records.set('item-flagged' as ItemId, { itemId: 'item-flagged' as ItemId, snapshotOnly: true, dirty: true })
    store.records.set('item-unflagged' as ItemId, { itemId: 'item-unflagged' as ItemId, snapshotOnly: true })

    await load()
    await state.save()

    expect(state.listDirty()).toEqual(['item-flagged', 'item-unflagged'])
    expect(store.db.update).toHaveBeenCalledWith(expect.anything(), ['item-unflagged'], expect.any(Function))
    expect(store.get('item-unflagged')).toEqual({ itemId: 'item-unflagged', snapshotOnly: true, dirty: true })
  })

  it('keeps the higher of a stored and a tracked base version', async () => {
    store.records.set('item-1' as ItemId, { itemId: 'item-1' as ItemId, baseVersion: 3 })
    await state.importBaseVersions([['item-1' as ItemId, 5]])
    store.records.set('item-1' as ItemId, { itemId: 'item-1' as ItemId, baseVersion: 7 })

    await load()

    expect(state.getBaseVersion('item-1' as ItemId)).toBe(7)
  })

  describe('importVersions', () => {
    it('raises base versions and saves them, keeping the dirty flag', async () => {
      tracker.markItemDirty('item-1' as ItemId)

      await state.importBaseVersions([['item-1' as ItemId, 3], ['item-2' as ItemId, 5]])
      await state.importBaseVersions([['item-1' as ItemId, 2]])

      expect(store.get('item-1')).toEqual({ itemId: 'item-1', baseVersion: 3, dirty: true })
      expect(store.get('item-2')).toEqual({ itemId: 'item-2', baseVersion: 5 })
    })

    it('keeps the rest of the record', async () => {
      store.records.set('item-1' as ItemId, { itemId: 'item-1' as ItemId, serverHeads: ['h'] })

      await state.importBaseVersions([['item-1' as ItemId, 3]])

      expect(store.get('item-1')).toEqual({ itemId: 'item-1', serverHeads: ['h'], baseVersion: 3 })
    })

    it('leaves another item\'s unsaved flag for a restarted tracker to restore', async () => {
      tracker.markItemDirty('item-offline' as ItemId)
      await state.importBaseVersions([['item-server' as ItemId, 2]])

      const restartedSession = new SyncSessionState()
      const restartedState = new ItemSyncState({ db: store.db, session: restartedSession })
      const restarted = new SnapshotSchedule({ state: restartedState, recoveryManager: mockRecoveryManager, session: restartedSession })
      await restarted.load()

      expect(restartedState.listDirty()).toEqual(['item-offline'])
    })
  })

  describe('deleteDirtyItem', () => {
    it('removes item from dirtyItems and clears the due time when dirtyItems becomes empty', async () => {
      tracker.markItemDirty('item-1' as ItemId)
      expect(state.getDirtyTick('item-1' as ItemId)).toBeDefined()
      expect(tracker.nextDueAt).toBeDefined()

      const deleted = tracker.deleteDirtyItem('item-1' as ItemId)
      expect(deleted).toBe(true)
      expect(state.getDirtyTick('item-1' as ItemId)).toBeUndefined()
      expect(state.dirtyCount).toBe(0)

      // A later edit starts a new debounce and max wait rather than inheriting the old ones
      vi.setSystemTime(4000)
      tracker.markItemDirty('item-2' as ItemId)
      expect(tracker.nextDueAt).toBe(5000)
      tracker.deleteDirtyItem('item-2' as ItemId)
      expect(tracker['maxWaitDueAt']).toBeUndefined()
    })

    it('clears the flag so the startup audit does not restore it', async () => {
      tracker.markItemDirty('item-1' as ItemId)
      await state.save()

      tracker.deleteDirtyItem('item-1' as ItemId)
      await state.save()
      await load()

      expect(store.get('item-1')).toEqual({ itemId: 'item-1' })
      expect(state.dirtyCount).toBe(0)
    })

    it('returns false when deleting an item that was not dirty', () => {
      expect(tracker.deleteDirtyItem('item-not-dirty' as ItemId)).toBe(false)
    })
  })

  describe('shutdown', () => {
    it('saves what this tab changed', async () => {
      tracker.markItemDirty('item-1' as ItemId)
      state.raiseBaseVersion('item-2' as ItemId, 4)

      await shutDown()

      expect(store.get('item-1')).toEqual({ itemId: 'item-1', dirty: true })
      expect(store.get('item-2')).toEqual({ itemId: 'item-2', baseVersion: 4 })
    })

    it('resets in-memory state with clearLocalData without saving', async () => {
      await state.importBaseVersions([['item-1' as ItemId, 3]])
      tracker.markItemDirty('item-dirty' as ItemId)
      store.db.update.mockClear()

      await shutDown({ clearLocalData: true })

      expect(state.listBaseVersions().size).toBe(0)
      expect(state.dirtyCount).toBe(0)
      expect(store.db.update).not.toHaveBeenCalled()

      // No debounced save fires afterwards
      await vi.advanceTimersByTimeAsync(5000)
      expect(store.db.update).not.toHaveBeenCalled()
    })

    it('saves dirty items once without leaving a debounced save behind', async () => {
      tracker.markItemDirty('item-1' as ItemId)

      await shutDown()

      expect(store.db.update).toHaveBeenCalledTimes(1)

      // Advance timers to verify no dangling timer fires
      await vi.advanceTimersByTimeAsync(5000)
      expect(store.db.update).toHaveBeenCalledTimes(1)
      expect(tracker.nextDueAt).toBeUndefined()
    })

    it('ignores markItemDirty after shutdown', async () => {
      await shutDown()

      tracker.markItemDirty('item-after-shutdown' as ItemId)
      await vi.advanceTimersByTimeAsync(5000)

      expect(store.db.update).not.toHaveBeenCalled()
      expect(state.dirtyCount).toBe(0)
    })
  })

  describe('saving records', () => {
    it('save throws a failure, and saves the items next time', async () => {
      const quotaError = new DOMException('Quota exceeded', 'QuotaExceededError')
      store.db.update.mockRejectedValueOnce(quotaError)
      tracker.markItemDirty('item-1' as ItemId)

      await expect(state.save()).rejects.toBe(quotaError)
      await state.save()

      expect(store.get('item-1')).toEqual({ itemId: 'item-1', dirty: true })
    })

    it('a debounced save logs a failure instead of throwing', async () => {
      store.db.update.mockRejectedValueOnce(new DOMException('Quota exceeded', 'QuotaExceededError'))
      tracker.markItemDirty('item-1' as ItemId)

      await vi.advanceTimersByTimeAsync(1000)
      expect(store.db.update).toHaveBeenCalledTimes(1)
      expect(store.get('item-1')).toBeUndefined()
    })
  })

  describe('a displaced session', () => {
    it("keeps the active session's progress when a displaced (frozen) one with older state saves", async () => {
      const makeTab = () => {
        const tabSession = new SyncSessionState()
        const tabState = new ItemSyncState({ db: store.db, session: tabSession })
        return {
          state: tabState,
          schedule: new SnapshotSchedule({ state: tabState, recoveryManager: mockRecoveryManager, session: tabSession }),
        }
      }
      const leader = makeTab()
      const follower = makeTab()

      // The displaced session loaded before the active one uploaded these snapshots
      leader.schedule.markItemDirty('item-1' as ItemId)
      leader.state.clearDirty('item-1' as ItemId, leader.state.getDirtyTick('item-1' as ItemId))
      leader.state.raiseBaseVersion('item-1' as ItemId, 5)
      leader.state.raiseBaseVersion('item-2' as ItemId, 3)
      await leader.state.save()
      follower.schedule.markItemDirty('item-3' as ItemId)
      await follower.state.save()

      expect(store.get('item-1')).toEqual({ itemId: 'item-1', baseVersion: 5 })
      expect(store.get('item-2')).toEqual({ itemId: 'item-2', baseVersion: 3 })
      expect(store.get('item-3')).toEqual({ itemId: 'item-3', dirty: true })
    })
  })
})
