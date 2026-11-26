import { queueFlaggedItems } from './startupAudit'
import { SnapshotSchedule } from './SnapshotSchedule'
import { ItemSyncState } from './ItemSyncState'
import { SyncSessionState } from './SyncSessionState'
import { createMemoryItemRecords } from './__test__/testUtils'
import { type ItemId, MAX_ITEM_SIZE_KB } from '@vault/shared'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'

describe('queueFlaggedItems', () => {
  let store: ReturnType<typeof createMemoryItemRecords>
  let session: SyncSessionState
  let state: ItemSyncState
  let schedule: SnapshotSchedule
  let recoveryManager: any

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    store = createMemoryItemRecords()
    session = new SyncSessionState()
    state = new ItemSyncState({ db: store.db, session })
    schedule = new SnapshotSchedule({ state, session })
    recoveryManager = { listRecoveryItems: vi.fn().mockResolvedValue([]) }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** Loads the records and runs the audit, as the context does at start */
  async function load(): Promise<void> {
    await queueFlaggedItems(await state.load(), { recoveryManager, schedule, session })
  }

  it('queues the flagged items, skipping quarantined ones, due after restoredSnapshotDelay', async () => {
    store.records.set('item-flagged' as ItemId, { itemId: 'item-flagged' as ItemId, dirty: true })
    store.records.set('item-synced' as ItemId, { itemId: 'item-synced' as ItemId, baseVersion: 2 })
    store.records.set('item-quarantined' as ItemId, { itemId: 'item-quarantined' as ItemId, dirty: true })
    store.records.set('item-oversized' as ItemId, { itemId: 'item-oversized' as ItemId, snapshotOnly: true })
    recoveryManager.listRecoveryItems.mockResolvedValue([
      { itemId: 'item-quarantined', reason: 'Decryption failed', kind: 'pullDecryption' },
      { itemId: 'item-oversized', reason: `Snapshot size exceeds ${MAX_ITEM_SIZE_KB} KB limit`, kind: 'oversized' },
    ])

    await load()

    expect(state.listDirty()).toEqual(['item-flagged'])
    expect(schedule.nextDueAt).toBe(SYNC_TIMEOUTS.restoredSnapshotDelay)
  })

  it('queues every flagged item when the quarantine cannot be read', async () => {
    store.records.set('item-flagged' as ItemId, { itemId: 'item-flagged' as ItemId, dirty: true })
    recoveryManager.listRecoveryItems.mockRejectedValue(new Error('unreadable'))

    await load()

    expect(state.listDirty()).toEqual(['item-flagged'])
  })

  it('re-queues a snapshot-only item, writing its dirty flag only where it lacks one', async () => {
    store.records.set('item-flagged' as ItemId, { itemId: 'item-flagged' as ItemId, snapshotOnly: true, dirty: true })
    store.records.set('item-unflagged' as ItemId, { itemId: 'item-unflagged' as ItemId, snapshotOnly: true })

    await load()
    await state.save()

    expect(state.listDirty()).toEqual(['item-flagged', 'item-unflagged'])
    expect(store.db.update).toHaveBeenCalledWith(expect.anything(), ['item-unflagged'], expect.any(Function))
    expect(store.get('item-unflagged')).toEqual({ itemId: 'item-unflagged', snapshotOnly: true, dirty: true })
  })

  it('does not restore an item whose flag was cleared', async () => {
    schedule.markItemDirty('item-1' as ItemId)
    await state.save()
    schedule.deleteDirtyItem('item-1' as ItemId)
    await state.save()

    await load()

    expect(store.get('item-1')).toEqual({ itemId: 'item-1' })
    expect(state.dirtyCount).toBe(0)
  })

  it('queues nothing once the session stopped while the quarantine was read', async () => {
    store.records.set('item-flagged' as ItemId, { itemId: 'item-flagged' as ItemId, dirty: true })
    recoveryManager.listRecoveryItems.mockImplementation(async () => {
      session.markShutdown()
      return []
    })

    await load()

    expect(state.dirtyCount).toBe(0)
  })
})
