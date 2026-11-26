import * as Automerge from '@automerge/automerge/slim'
import { IDBFactory } from 'fake-indexeddb'
import type { ItemId } from '@vault/shared'
import { ItemSyncState } from './ItemSyncState'
import { SyncSessionState } from './SyncSessionState'
import { SyncLogDatabase } from './stores/SyncLogDatabase'
import { SYNC_LOG_STORES } from '../shared/syncLogStorage'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'
import type { ItemSyncRecord } from './stores/itemSyncRecords'

const ITEM_1 = 'item-1' as ItemId
const ITEM_2 = 'item-2' as ItemId

describe('ItemSyncState', () => {
  let db: SyncLogDatabase
  const states: ItemSyncState[] = []

  const stored = () => db.getAll<ItemSyncRecord>(SYNC_LOG_STORES.items)
  const storedRecord = async (itemId: ItemId) => (await stored()).find(record => record.itemId === itemId)

  /** A tab's state over the shared database */
  function createState(now?: () => number): ItemSyncState {
    const state = new ItemSyncState({ db, session: new SyncSessionState(), now })
    states.push(state)
    return state
  }

  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    db = new SyncLogDatabase('account-1')
  })

  afterEach(async () => {
    for (const state of states.splice(0)) {
      await state.shutdown({ clearLocalData: true })
    }
    await db.close()
  })

  describe('server heads', () => {
    it('has no heads for an item it has never seen', () => {
      const state = createState()

      expect(state.getServerHeads(ITEM_1)).toEqual([])
      expect(state.hasServerHeads(ITEM_1)).toBe(false)
    })

    it('loads the stored heads', async () => {
      await db.put(SYNC_LOG_STORES.items, { itemId: ITEM_1, serverHeads: ['a'] }, { itemId: ITEM_2, baseVersion: 2 })
      const state = createState()

      await state.load()

      expect(state.getServerHeads(ITEM_1)).toEqual(['a'])
      expect(state.hasServerHeads(ITEM_2)).toBe(false)
      expect(state.getBaseVersion(ITEM_2)).toBe(2)
    })

    it('writes nothing when no heads changed', async () => {
      await db.put(SYNC_LOG_STORES.items, { itemId: ITEM_1, serverHeads: ['a'] })
      const state = createState()
      await state.load()
      const update = vi.spyOn(db, 'update')

      state.setServerHeads(ITEM_1, ['a'])
      await state.save()

      expect(update).not.toHaveBeenCalled()
    })
  })

  describe('advancing server heads to a snapshot\'s', () => {
    /** A doc whose server heads are past a stale snapshot's, and one where they're on another branch */
    function histories() {
      const base = Automerge.change(Automerge.init<Record<string, number>>({ actor: 'aa' }), doc => { doc.a = 1 })
      const pushed = Automerge.change(Automerge.clone(base), doc => { doc.b = 1 })
      const other = Automerge.change(Automerge.clone(base, { actor: 'bb' }), doc => { doc.c = 1 })
      return {
        doc: Automerge.merge(Automerge.clone(pushed), other),
        base: Automerge.getHeads(base),
        pushed: Automerge.getHeads(pushed),
        other: Automerge.getHeads(other),
      }
    }

    it('takes the snapshot\'s heads for an item with none', () => {
      const state = createState()
      const { doc, other } = histories()

      state.advanceServerHeads(ITEM_1, other, doc)

      expect(state.getServerHeads(ITEM_1)).toEqual(other)
    })

    it('never moves them back to a snapshot they are already past', () => {
      const state = createState()
      const { doc, base, pushed } = histories()
      state.setServerHeads(ITEM_1, pushed)

      state.advanceServerHeads(ITEM_1, base, doc)

      expect(state.getServerHeads(ITEM_1)).toEqual(pushed)
    })

    it('moves them to a snapshot past them', () => {
      const state = createState()
      const { doc, base, pushed } = histories()
      state.setServerHeads(ITEM_1, base)

      state.advanceServerHeads(ITEM_1, pushed, doc)

      expect(state.getServerHeads(ITEM_1)).toEqual(pushed)
    })

    it('takes the frontier of both when they have diverged, so a push sends nothing either holds', () => {
      const state = createState()
      const { doc, pushed, other } = histories()
      state.setServerHeads(ITEM_1, pushed)

      state.advanceServerHeads(ITEM_1, other, doc)

      expect(state.getServerHeads(ITEM_1).sort()).toEqual([...pushed, ...other].sort())
      expect(state.isCovered(ITEM_1, doc)).toBe(true)
    })

    it('keeps its heads when there is no loaded doc to compare them in', () => {
      const state = createState()
      const { base, pushed } = histories()
      state.setServerHeads(ITEM_1, pushed)

      state.advanceServerHeads(ITEM_1, base, undefined)

      expect(state.getServerHeads(ITEM_1)).toEqual(pushed)
    })
  })

  describe('saving', () => {
    it('saves after the debounce, and within the max wait while changes keep coming', async () => {
      vi.useFakeTimers()
      try {
        const state = createState()
        // Fake timers would hold up fake-indexeddb's transactions
        const update = vi.spyOn(db, 'update').mockResolvedValue(undefined)
        for (let elapsed = 0; elapsed < SYNC_TIMEOUTS.itemSyncSaveMaxWait; elapsed += SYNC_TIMEOUTS.itemSyncSave / 2) {
          state.markDirty(ITEM_1)
          await vi.advanceTimersByTimeAsync(SYNC_TIMEOUTS.itemSyncSave / 2)
        }
        expect(update).toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })

    it('saves at once when a pending save is flushed', async () => {
      const state = createState()
      state.markDirty(ITEM_1)

      state.flushPendingSave()
      await vi.waitFor(async () => expect(await stored()).toEqual([{ itemId: ITEM_1, dirty: true }]))
    })

    it('throws a failure, keeping the fields unsaved for the next save', async () => {
      const state = createState()
      const quota = new DOMException('Quota exceeded', 'QuotaExceededError')
      vi.spyOn(db, 'update').mockRejectedValueOnce(quota)
      state.setServerHeads(ITEM_1, ['a'])

      await expect(state.save()).rejects.toBe(quota)
      state.markDirty(ITEM_1)
      await state.save()

      expect(await stored()).toEqual([{ itemId: ITEM_1, serverHeads: ['a'], dirty: true }])
    })

    it('saves on shutdown, unless local data is being cleared', async () => {
      const clearing = createState()
      clearing.setServerHeads(ITEM_1, ['a'])
      await clearing.shutdown({ clearLocalData: true })
      expect(await stored()).toEqual([])

      const stopping = createState()
      stopping.setServerHeads(ITEM_1, ['a'])
      await stopping.shutdown()
      expect(await stored()).toEqual([{ itemId: ITEM_1, serverHeads: ['a'] }])
    })

    it('ignores changes once it has stopped', async () => {
      const state = createState()
      await state.shutdown()
      const update = vi.spyOn(db, 'update')

      state.markDirty(ITEM_1)
      state.setServerHeads(ITEM_1, ['a'])
      await state.save()

      expect(update).not.toHaveBeenCalled()
    })
  })

  describe('across tabs, a save writes only the fields this tab changed', () => {
    it('keeps another item\'s record', async () => {
      await db.put(SYNC_LOG_STORES.items, { itemId: ITEM_1, serverHeads: ['from another tab'] })
      const state = createState()

      state.setServerHeads(ITEM_2, ['mine'])
      await state.save()

      expect(await stored()).toEqual([
        { itemId: ITEM_1, serverHeads: ['from another tab'] },
        { itemId: ITEM_2, serverHeads: ['mine'] },
      ])
    })

    it('keeps the leader\'s newer heads when a follower with stale ones marks the item dirty', async () => {
      await db.put(SYNC_LOG_STORES.items, { itemId: ITEM_1, serverHeads: ['old'] })
      const leader = createState()
      const follower = createState()
      await Promise.all([leader.load(), follower.load()])

      leader.setServerHeads(ITEM_1, ['new'])
      leader.setSnapshotOnly(ITEM_1)
      await leader.save()
      follower.markDirty(ITEM_1)
      await follower.save()

      expect(follower.getServerHeads(ITEM_1)).toEqual(['old'])
      expect(await storedRecord(ITEM_1)).toEqual({ itemId: ITEM_1, serverHeads: ['new'], snapshotOnly: true, dirty: true })
    })

    it('keeps the new leader\'s fields when a tab that stopped leading saves after it loaded', async () => {
      const oldLeader = createState()
      const newLeader = createState()
      oldLeader.setServerHeads(ITEM_1, ['from the old leader'])
      oldLeader.markDirty(ITEM_1)
      await oldLeader.save()
      newLeader.queueFlagged(await newLeader.load())

      // The new leader uploads the item's snapshot, and then the old one saves a late change
      newLeader.clearDirty(ITEM_1)
      newLeader.raiseBaseVersion(ITEM_1, 4)
      newLeader.setServerHeads(ITEM_1, ['from the new leader'])
      await newLeader.save()
      oldLeader.raiseBaseVersion(ITEM_1, 2)
      await oldLeader.save()

      expect(await storedRecord(ITEM_1)).toEqual({ itemId: ITEM_1, serverHeads: ['from the new leader'], baseVersion: 4 })
    })

    it('keeps the rest of the item\'s record', async () => {
      await db.put(SYNC_LOG_STORES.items, { itemId: ITEM_1, baseVersion: 4, dirty: true, pulledAt: 10 })
      const state = createState()

      state.setServerHeads(ITEM_1, ['a'])
      await state.save()

      expect(await stored()).toEqual([{ itemId: ITEM_1, baseVersion: 4, dirty: true, pulledAt: 10, serverHeads: ['a'] }])
    })

    it('clears a flag only when this tab cleared it', async () => {
      await db.put(SYNC_LOG_STORES.items, { itemId: ITEM_1, dirty: true }, { itemId: ITEM_2, dirty: true })
      const state = createState()
      state.queueFlagged(await state.load())

      state.clearDirty(ITEM_1)
      state.setServerHeads(ITEM_2, ['a'])
      await state.save()

      expect(await stored()).toEqual([{ itemId: ITEM_1 }, { itemId: ITEM_2, dirty: true, serverHeads: ['a'] }])
    })
  })

  describe('load', () => {
    it('keeps fields this tab has not saved over the stored ones', async () => {
      await db.put(SYNC_LOG_STORES.items, { itemId: ITEM_1, serverHeads: ['stored'], dirty: true })
      const state = createState()
      state.setServerHeads(ITEM_1, ['newer'])
      state.markDirty(ITEM_1)
      state.clearDirty(ITEM_1)

      await state.load()

      expect(state.getServerHeads(ITEM_1)).toEqual(['newer'])
      expect(state.listFlagged()).toEqual([])
    })

    it('keeps the fields a save in flight is writing, and the save writes them as they were', async () => {
      const state = createState()
      state.markDirty(ITEM_1)
      state.setServerHeads(ITEM_1, ['mine'])
      const update = db.update.bind(db)
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      vi.spyOn(db, 'update').mockImplementationOnce(async (...args) => {
        await gate
        return update(...args)
      })

      const saving = state.save()
      // Reads the store before the save has written it
      await state.load()
      release()
      await saving

      expect(state.listFlagged()).toEqual([ITEM_1])
      expect(state.getServerHeads(ITEM_1)).toEqual(['mine'])
      expect(await stored()).toEqual([{ itemId: ITEM_1, dirty: true, serverHeads: ['mine'] }])
    })

    it('takes the stored values of fields this tab has saved', async () => {
      const state = createState()
      state.setServerHeads(ITEM_1, ['mine'])
      await state.save()
      await db.put(SYNC_LOG_STORES.items, { itemId: ITEM_1, serverHeads: ['from the leader'] })

      await state.load()

      expect(state.getServerHeads(ITEM_1)).toEqual(['from the leader'])
    })

    it('loads once for callers that join a load in flight', async () => {
      const getAll = vi.spyOn(db, 'getAll')
      const state = createState()

      await Promise.all([state.load(), state.load()])

      expect(getAll.mock.calls.filter(([store]) => store === SYNC_LOG_STORES.items)).toHaveLength(1)
    })

    it('lists items flagged dirty or snapshot-only', async () => {
      await db.put(
        SYNC_LOG_STORES.items,
        { itemId: ITEM_1, dirty: true },
        { itemId: ITEM_2, snapshotOnly: true },
        { itemId: 'item-3' as ItemId, baseVersion: 2 },
      )
      const state = createState()

      await state.load()

      expect(state.listFlagged()).toEqual([ITEM_1, ITEM_2])
    })
  })

  describe('dirty items', () => {
    it('ticks each marking, so a stale tick leaves the item dirty', async () => {
      const state = createState()
      state.markDirty(ITEM_1)
      const firstTick = state.getDirtyTick(ITEM_1)!
      state.markDirty(ITEM_2)
      state.markDirty(ITEM_1)

      expect(state.getDirtyTick(ITEM_1)).toBeGreaterThan(firstTick)
      expect(state.clearDirty(ITEM_1, firstTick)).toBe(false)
      expect(state.listDirty()).toEqual([ITEM_1, ITEM_2])

      expect(state.clearDirty(ITEM_1, state.getDirtyTick(ITEM_1))).toBe(true)
      await state.save()

      expect(state.isDirty(ITEM_1)).toBe(false)
      expect(state.dirtyCount).toBe(1)
      expect(await stored()).toEqual([{ itemId: ITEM_1 }, { itemId: ITEM_2, dirty: true }])
    })

    it('clears without a tick whatever the tick, and only an item it queued', async () => {
      await db.put(SYNC_LOG_STORES.items, { itemId: ITEM_2, dirty: true })
      const state = createState()
      await state.load()
      state.markDirty(ITEM_1)

      expect(state.clearDirty(ITEM_1)).toBe(true)
      // Flagged by an earlier session, but not queued in this one
      expect(state.clearDirty(ITEM_2)).toBe(false)
      expect(state.listFlagged()).toEqual([ITEM_2])
    })

    it('keeps the queue over a load, which replaces the records', async () => {
      const state = createState()
      state.markDirty(ITEM_1)
      const tick = state.getDirtyTick(ITEM_1)
      await state.save()
      await db.put(SYNC_LOG_STORES.items, { itemId: ITEM_1, baseVersion: 3 })

      await state.load()

      expect(state.getDirtyTick(ITEM_1)).toBe(tick)
      expect(await stored()).toEqual([{ itemId: ITEM_1, baseVersion: 3 }])
    })

    it('never saves a tick', async () => {
      const state = createState()
      state.markDirty(ITEM_1)

      await state.save()

      expect(await stored()).toEqual([{ itemId: ITEM_1, dirty: true }])
    })

    it('loads the flagged items it has not queued, queues them once, and flags legacy snapshot-only ones', async () => {
      await db.put(
        SYNC_LOG_STORES.items,
        { itemId: ITEM_1, dirty: true },
        { itemId: ITEM_2, snapshotOnly: true },
        { itemId: 'item-3' as ItemId, dirty: true },
        { itemId: 'item-4' as ItemId, baseVersion: 2 },
      )
      const state = createState()
      const flagged = await state.load()
      const update = vi.spyOn(db, 'update')

      expect(flagged).toEqual([ITEM_1, ITEM_2, 'item-3'])
      expect(state.queueFlagged([ITEM_1, ITEM_2, 'item-4' as ItemId])).toBe(2)
      expect(state.queueFlagged(flagged)).toBe(1)
      expect(await state.load()).toEqual([])
      await state.save()

      expect(state.listDirty()).toEqual([ITEM_1, ITEM_2, 'item-3'])
      // Only the snapshot-only item lacked its flag
      expect(update).toHaveBeenCalledWith(expect.anything(), [ITEM_2], expect.any(Function))
      expect(await storedRecord(ITEM_2)).toEqual({ itemId: ITEM_2, snapshotOnly: true, dirty: true })
    })

    it('forgets the queue once stopped', async () => {
      const state = createState()
      state.markDirty(ITEM_1)

      await state.shutdown({ clearLocalData: true })
      state.markDirty(ITEM_2)

      expect(state.dirtyCount).toBe(0)
    })
  })

  describe('base versions (sync rule 8)', () => {
    it('never lowers a base version in memory', () => {
      const state = createState()

      state.raiseBaseVersion(ITEM_1, 5)
      state.raiseBaseVersion(ITEM_1, 3)

      expect(state.getBaseVersion(ITEM_1)).toBe(5)
    })

    it('keeps the higher of this tab\'s and the stored one on load', async () => {
      const state = createState()
      await state.importBaseVersions([[ITEM_1, 5], [ITEM_2, 5]])
      await db.put(SYNC_LOG_STORES.items, { itemId: ITEM_1, baseVersion: 7 }, { itemId: ITEM_2, baseVersion: 3 })

      await state.load()

      expect(state.getBaseVersion(ITEM_1)).toBe(7)
      expect(state.getBaseVersion(ITEM_2)).toBe(5)
    })

    it('keeps the higher of this tab\'s and the stored one on save', async () => {
      const state = createState()
      state.raiseBaseVersion(ITEM_1, 5)
      await db.put(SYNC_LOG_STORES.items, { itemId: ITEM_1, baseVersion: 7 })

      await state.save()

      expect(await storedRecord(ITEM_1)).toEqual({ itemId: ITEM_1, baseVersion: 7 })
    })

    it('keeps an unsaved raise over a lower stored version on load', async () => {
      const state = createState()
      state.raiseBaseVersion(ITEM_1, 5)
      await db.put(SYNC_LOG_STORES.items, { itemId: ITEM_1, baseVersion: 3 })

      await state.load()

      expect(state.getBaseVersion(ITEM_1)).toBe(5)
    })

    it('imports base versions and saves them, logging a failure', async () => {
      const state = createState()
      vi.spyOn(db, 'update').mockRejectedValueOnce(new Error('quota'))

      await expect(state.importBaseVersions([[ITEM_1, 3]])).resolves.toBeUndefined()
      await state.importBaseVersions([[ITEM_2, 4]])

      expect(state.listBaseVersions()).toEqual(new Map([[ITEM_1, 3], [ITEM_2, 4]]))
      expect(await stored()).toEqual([{ itemId: ITEM_1, baseVersion: 3 }, { itemId: ITEM_2, baseVersion: 4 }])
    })
  })

  describe('snapshot-only items', () => {
    it('are queued and flagged dirty in the same save', async () => {
      const state = createState()
      state.setSnapshotOnly(ITEM_1)
      const tick = state.getDirtyTick(ITEM_1)
      await state.save()

      expect(state.isDirty(ITEM_1)).toBe(true)
      expect(await stored()).toEqual([{ itemId: ITEM_1, snapshotOnly: true, dirty: true }])

      // Marking it again moves its tick, as a new edit would
      state.setSnapshotOnly(ITEM_1)
      expect(state.getDirtyTick(ITEM_1)).toBeGreaterThan(tick!)
    })

    it('survive a reload', async () => {
      const state = createState()
      state.setSnapshotOnly(ITEM_1)
      await state.shutdown()

      const reloaded = createState()
      await reloaded.load()

      expect(reloaded.isSnapshotOnly(ITEM_1)).toBe(true)
      expect(reloaded.listFlagged()).toEqual([ITEM_1])
    })

    it('take the confirmed snapshot\'s heads as their server heads', async () => {
      const state = createState()
      state.setServerHeads(ITEM_1, ['old'])
      state.setSnapshotOnly(ITEM_1)

      state.confirmSnapshotOnly(ITEM_1, ['snapshot'])
      await state.save()

      expect(state.isSnapshotOnly(ITEM_1)).toBe(false)
      expect(state.getServerHeads(ITEM_1)).toEqual(['snapshot'])
      // The upload that confirms it clears the dirty flag, which this doesn't touch
      expect(await stored()).toEqual([{ itemId: ITEM_1, serverHeads: ['snapshot'], dirty: true }])
    })

    it('confirm nothing for an item that is not snapshot-only', () => {
      const state = createState()
      state.setServerHeads(ITEM_1, ['old'])

      state.confirmSnapshotOnly(ITEM_1, ['snapshot'])

      expect(state.getServerHeads(ITEM_1)).toEqual(['old'])
    })
  })

  describe('unconfirmed pulls (S2)', () => {
    it('keeps when an item first gained pulled changes, saved before it resolves', async () => {
      const now = vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(200)
      const state = createState(now)

      await state.recordPulledChanges([ITEM_1])
      expect(await storedRecord(ITEM_1)).toEqual({ itemId: ITEM_1, pulledAt: 100 })
      await state.recordPulledChanges([ITEM_1])

      expect(state.listUnconfirmedPulls()).toEqual(new Map([[ITEM_1, 100]]))
      expect(await storedRecord(ITEM_1)).toEqual({ itemId: ITEM_1, pulledAt: 100 })
    })

    it('keeps the earlier time another tab stored', async () => {
      const state = createState(() => 200)
      await db.put(SYNC_LOG_STORES.items, { itemId: ITEM_1, pulledAt: 100 })

      await state.recordPulledChanges([ITEM_1])

      expect(await storedRecord(ITEM_1)).toEqual({ itemId: ITEM_1, pulledAt: 100 })
    })

    it('throws when the record can\'t be saved', async () => {
      const state = createState()
      vi.spyOn(db, 'update').mockRejectedValueOnce(new Error('IndexedDB write failed'))

      await expect(state.recordPulledChanges([ITEM_1])).rejects.toThrow('IndexedDB write failed')
    })

    it('forgets items a snapshot has confirmed', async () => {
      const state = createState()
      await state.recordPulledChanges([ITEM_1])

      await state.confirmPulledChanges([ITEM_1])

      expect(state.listUnconfirmedPulls().size).toBe(0)
      expect(await stored()).toEqual([{ itemId: ITEM_1 }])
    })

    it('survive a reload', async () => {
      const state = createState(() => 100)
      await state.recordPulledChanges([ITEM_1])

      const reloaded = createState()
      await reloaded.load()

      expect(reloaded.listUnconfirmedPulls()).toEqual(new Map([[ITEM_1, 100]]))
    })
  })

  describe('snapshot coverage (S1, log before snapshot)', () => {
    const base = () => Automerge.change(Automerge.init<{ title?: string }>(), d => { d.title = 'base' })

    it('covers a doc at its server heads', () => {
      const state = createState()
      const doc = base()
      state.setServerHeads(ITEM_1, Automerge.getHeads(doc))

      expect(state.isCovered(ITEM_1, doc)).toBe(true)
    })

    it('defers a doc with changes after its server heads', () => {
      const state = createState()
      const doc = base()
      state.setServerHeads(ITEM_1, Automerge.getHeads(doc))

      const edited = Automerge.change(doc, d => { d.title = 'edited' })

      expect(state.isCovered(ITEM_1, edited)).toBe(false)
    })

    it('defers a doc with no known server heads, which is all unpushed', () => {
      expect(createState().isCovered(ITEM_1, base())).toBe(false)
    })

    it('lets through a change too large for a row', () => {
      const state = createState()
      state.setSnapshotOnly(ITEM_1)

      expect(state.isCovered(ITEM_1, base())).toBe(true)
    })
  })
})
