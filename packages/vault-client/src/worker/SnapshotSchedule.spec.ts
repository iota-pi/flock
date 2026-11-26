import { SnapshotSchedule } from './SnapshotSchedule'
import { ItemSyncState } from './ItemSyncState'
import { createMemoryItemRecords } from './__test__/testUtils'
import type { ItemId } from '@vault/shared'
import { SyncSessionState } from './SyncSessionState'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'

// The due times themselves are `snapshotDue.spec.ts`'s table: this covers what the schedule does around them
describe('SnapshotSchedule', () => {
  let schedule: SnapshotSchedule
  let state: ItemSyncState
  let session: SyncSessionState
  let store: ReturnType<typeof createMemoryItemRecords>
  let onDueChanged: ReturnType<typeof vi.fn<() => void>>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    onDueChanged = vi.fn<() => void>()
    store = createMemoryItemRecords()
    session = new SyncSessionState()
    state = new ItemSyncState({ db: store.db, session })
    schedule = new SnapshotSchedule({ state, session, onDueChanged: () => onDueChanged() })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('queues a marked item with a new tick, due a debounce later', () => {
    schedule.markItemDirty('item-1' as ItemId)
    schedule.markItemDirty('item-2' as ItemId)

    expect(state.getDirtyTick('item-1' as ItemId)).toBe(1)
    expect(state.getDirtyTick('item-2' as ItemId)).toBe(2)
    expect(schedule.nextDueAt).toBe(SYNC_TIMEOUTS.snapshotDebounce)
    expect(schedule.isDue()).toBe(false)
    vi.setSystemTime(SYNC_TIMEOUTS.snapshotDebounce)
    expect(schedule.isDue()).toBe(true)
  })

  it('tells the orchestrator each time an edit changes when uploads are due', () => {
    schedule.markItemDirty('item-1' as ItemId)
    schedule.markItemDirty('item-2' as ItemId, 0)

    expect(onDueChanged).toHaveBeenCalledTimes(2)
  })

  describe('restored items', () => {
    beforeEach(async () => {
      store.records.set('item-flagged' as ItemId, { itemId: 'item-flagged' as ItemId, dirty: true })
      store.records.set('item-queued' as ItemId, { itemId: 'item-queued' as ItemId, dirty: true })
      schedule.markItemDirty('item-queued' as ItemId)
      onDueChanged.mockClear()
    })

    it('queues those not queued yet, due after restoredSnapshotDelay', async () => {
      expect(schedule.queueRestored(await state.load())).toBe(1)

      expect(state.listDirty()).toEqual(['item-queued', 'item-flagged'])
      expect(schedule.nextDueAt).toBe(SYNC_TIMEOUTS.restoredSnapshotDelay)
      expect(onDueChanged).toHaveBeenCalledTimes(1)
    })

    it('changes nothing when none is left to queue', () => {
      expect(schedule.queueRestored(['item-queued' as ItemId])).toBe(0)

      expect(schedule.nextDueAt).toBe(SYNC_TIMEOUTS.snapshotDebounce)
      expect(onDueChanged).not.toHaveBeenCalled()
    })
  })

  describe('deleteDirtyItem', () => {
    it('takes the item out of the queue, and nothing stays due once none is left', () => {
      schedule.markItemDirty('item-1' as ItemId, 0)

      expect(schedule.deleteDirtyItem('item-1' as ItemId)).toBe(true)

      expect(state.dirtyCount).toBe(0)
      expect(schedule.nextDueAt).toBeUndefined()
      expect(schedule.isDue()).toBe(false)
    })

    it('returns false for an item that was not queued', () => {
      expect(schedule.deleteDirtyItem('item-not-dirty' as ItemId)).toBe(false)
    })
  })

  it('ignores marks once the session has shut down', () => {
    session.markShutdown()

    schedule.markItemDirty('item-1' as ItemId)

    expect(state.dirtyCount).toBe(0)
    expect(onDueChanged).not.toHaveBeenCalled()
  })
})
