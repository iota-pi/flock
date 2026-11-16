import { SnapshotTracker } from './SnapshotTracker'
import { getTimestamps, setTimestamps } from './__test__/testUtils'
import { type ItemId, MAX_ITEM_SIZE_KB } from '@vault/shared'
import type { LastModifiedStore } from './stores/LastModifiedStore'
import { SyncSessionState } from './SyncSessionState'

describe('SnapshotTracker', () => {
  let tracker: SnapshotTracker
  let session: SyncSessionState
  let mockStore: any
  let mockRecoveryManager: any
  let onDueChanged: ReturnType<typeof vi.fn<() => void>>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    onDueChanged = vi.fn<() => void>()
    mockStore = {
      loadTimestamps: vi.fn().mockResolvedValue([]),
      saveTimestamps: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    }
    mockRecoveryManager = {
      listRecoveryItems: vi.fn().mockResolvedValue([]),
    }

    session = new SyncSessionState({ isLeader: true })
    tracker = new SnapshotTracker({
      lastModifiedStore: mockStore as unknown as LastModifiedStore,
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

  /** Marks the session shut down and stops the tracker, as the context does */
  function shutDown(options?: { clearLocalData?: boolean }): Promise<void> {
    session.markShutdown()
    return tracker.shutdown(options)
  }

  it('marks items dirty with monotonic tick, due once the debounce expires', async () => {
    tracker.markItemDirty('item-1' as ItemId)
    expect(tracker.getDirtyTick('item-1' as ItemId)).toBe(1)
    expect(tracker.dirtyCount).toBe(1)

    tracker.markItemDirty('item-2' as ItemId)
    expect(tracker.getDirtyTick('item-2' as ItemId)).toBe(2)
    expect(tracker.dirtyCount).toBe(2)

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
    expect(tracker.dirtyCount).toBe(1)
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
  })

  describe('leadership', () => {
    it('makes the dirty items due after the debounce when this tab becomes the leader', () => {
      session.setLeader(false)
      tracker.markItemDirty('item-1' as ItemId)
      tracker.onLeaderChange()
      expect(tracker.nextDueAt).toBeUndefined()

      vi.setSystemTime(500)
      session.setLeader(true)
      tracker.onLeaderChange()

      expect(tracker.nextDueAt).toBe(1500)
    })
  })

  describe('default debounce and max wait', () => {
    beforeEach(() => {
      tracker = new SnapshotTracker({
        lastModifiedStore: mockStore as unknown as LastModifiedStore,
        recoveryManager: mockRecoveryManager,
        session,
      })
    })

    it('is due 30 seconds after an item is marked dirty', () => {
      tracker.markItemDirty('item-1' as ItemId)

      expect(tracker.nextDueAt).toBe(30_000)
    })

    it('puts the 30-second debounce off when another item is marked dirty before it ends', () => {
      tracker.markItemDirty('item-1' as ItemId)
      vi.setSystemTime(20_000)
      tracker.markItemDirty('item-2' as ItemId)

      expect(tracker.nextDueAt).toBe(50_000)
    })

    it('is due after maxWait (5 minutes) even if continuous changes keep putting the debounce off', () => {
      // Simulate typing every 10 seconds for 5 minutes
      for (let second = 0; second < 300; second += 10) {
        vi.setSystemTime(second * 1000)
        tracker.markItemDirty('item-1' as ItemId)
      }

      expect(tracker.nextDueAt).toBe(300_000)
    })

    it('markItemDirty respects custom debounce delay (e.g. 2000ms)', () => {
      tracker.markItemDirty('item-1' as ItemId, 2000)

      expect(tracker.isDue(1999)).toBe(false)
      expect(tracker.isDue(2000)).toBe(true)
    })
  })


  it('records local modification time for dirty items and persists it', async () => {
    vi.setSystemTime(12345)
    tracker.markItemDirty('item-1' as ItemId)
    expect(getTimestamps(tracker, 'item-1').localModifiedAt).toBe(12345)
    expect(mockStore.saveTimestamps).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1000)
    expect(mockStore.saveTimestamps).toHaveBeenCalled()
  })

  it('saves within maxWait while edits keep coming', async () => {
    for (let elapsed = 0; elapsed < 5000; elapsed += 500) {
      tracker.markItemDirty('item-1' as ItemId)
      await vi.advanceTimersByTimeAsync(500)
    }
    expect(mockStore.saveTimestamps).toHaveBeenCalled()
  })

  it('performs startup audit, restoring un-snapshotted items and skipping quarantined ones', async () => {
    mockStore.loadTimestamps.mockResolvedValue([
      ['item-clean' as ItemId, { localModifiedAt: 500, lastSnapshotAt: 100 }],
      ['item-synced' as ItemId, { localModifiedAt: 100, lastSnapshotAt: 100 }],
      ['item-quarantined' as ItemId, { localModifiedAt: 600, lastSnapshotAt: 100 }],
    ])

    mockRecoveryManager.listRecoveryItems.mockResolvedValue([
      { itemId: 'item-quarantined', reason: 'Decryption failed', kind: 'pullDecryption' },
      { itemId: 'item-oversized', reason: `Snapshot size exceeds ${MAX_ITEM_SIZE_KB} KB limit`, kind: 'oversized' },
      { itemId: 'item-rate-limited', reason: 'Push failed after 5 consecutive attempts: Rate limit exceeded', kind: 'unknown' },
    ])

    await tracker.loadLastModified()

    expect(tracker.dirtyCount).toBe(1) // Only item-clean restored
    expect(tracker.getDirtyTick('item-clean' as ItemId)).toBeDefined()
    expect(tracker.getDirtyTick('item-synced' as ItemId)).toBeUndefined()
    expect(tracker.getDirtyTick('item-quarantined' as ItemId)).toBeUndefined()
    expect(tracker['oversizedItems'].has('item-oversized' as ItemId)).toBe(true)
    expect(tracker['oversizedItems'].has('item-rate-limited' as ItemId)).toBe(false)
  })

  it('loads once for callers that join a load in flight', async () => {
    mockRecoveryManager.listRecoveryItems.mockResolvedValue([
      { itemId: 'item-oversized', reason: `Snapshot size exceeds ${MAX_ITEM_SIZE_KB} KB limit`, kind: 'oversized' },
    ])

    await Promise.all([tracker.loadLastModified(), tracker.loadLastModified()])

    expect(mockStore.loadTimestamps).toHaveBeenCalledTimes(1)
    expect([...tracker['oversizedItems']]).toEqual(['item-oversized'])
  })

  it('restores un-snapshotted and never-snapshotted items on load, then triggers a push', async () => {
    mockStore.loadTimestamps.mockResolvedValue([
      ['item-unpushed' as ItemId, { localModifiedAt: 5000, lastSnapshotAt: 2000 }],
      ['item-clean' as ItemId, { localModifiedAt: 3000, lastSnapshotAt: 3000 }],
      ['item-never-snapshotted' as ItemId, { localModifiedAt: 4000 }],
    ])

    await tracker.loadLastModified()

    expect(tracker.getDirtyItemIds()).toContain('item-unpushed' as ItemId)
    expect(tracker.getDirtyItemIds()).toContain('item-never-snapshotted' as ItemId)
    expect(tracker.getDirtyItemIds()).not.toContain('item-clean' as ItemId)

    // The restored items go up once the debounce elapses
    expect(tracker.nextDueAt).toBe(Date.now() + 1000)
    expect(onDueChanged).toHaveBeenCalled()
  })

  it('heals legacy stored data on load where localModifiedAt < lastSnapshotAt', async () => {
    mockStore.loadTimestamps.mockResolvedValue([
      ['item-legacy' as ItemId, { localModifiedAt: 1000, lastSnapshotAt: 5000 }],
    ])

    await tracker.loadLastModified()

    // localModifiedAt must be healed to at least lastSnapshotAt
    expect(getTimestamps(tracker, 'item-legacy').localModifiedAt).toBe(5000)
    expect(getTimestamps(tracker, 'item-legacy').lastSnapshotAt).toBe(5000)
    expect(tracker.getDirtyItemIds()).not.toContain('item-legacy')
    expect(tracker.exportLastModified()).toEqual([['item-legacy', 5000]])
  })

  it('recordSnapshotSuccess clears matching tick and updates lastSnapshotAt', () => {
    tracker.markItemDirty('item-1' as ItemId)
    const tick = tracker.getDirtyTick('item-1' as ItemId)!

    tracker.recordSnapshotSuccess('item-1' as ItemId, 2000, tick)

    expect(tracker.getDirtyTick('item-1' as ItemId)).toBeUndefined()
    expect(getTimestamps(tracker, 'item-1').lastSnapshotAt).toBe(2000)
  })

  it('recordSnapshotSuccess does not clear item if tick has changed (new edits)', () => {
    tracker.markItemDirty('item-1' as ItemId)
    const oldTick = tracker.getDirtyTick('item-1' as ItemId)!

    // Item was updated again before first snapshot completed
    tracker.markItemDirty('item-1' as ItemId)
    const newTick = tracker.getDirtyTick('item-1' as ItemId)!
    expect(newTick).toBeGreaterThan(oldTick)

    tracker.recordSnapshotSuccess('item-1' as ItemId, 2000, oldTick)

    expect(tracker.getDirtyTick('item-1' as ItemId)).toBeDefined()
    expect(getTimestamps(tracker, 'item-1').lastSnapshotAt).toBe(2000)
  })

  it('recordSnapshotSuccess without a tick keeps the item dirty and records the version', () => {
    tracker.markItemDirty('item-1' as ItemId)

    tracker.recordSnapshotSuccess('item-1' as ItemId, 2000, undefined, 7)

    expect(tracker.getDirtyTick('item-1' as ItemId)).toBeDefined()
    expect(tracker.exportItemVersions().get('item-1' as ItemId)?.baseVersion).toBe(7)
  })

  it('recordOversized removes item from dirty queue and advances lastSnapshotAt', () => {
    vi.setSystemTime(5000)
    tracker.markItemDirty('item-big' as ItemId)
    tracker.recordOversized('item-big' as ItemId, 3000)

    expect(tracker.getDirtyTick('item-big' as ItemId)).toBeUndefined()
    expect(getTimestamps(tracker, 'item-big').lastSnapshotAt).toBeGreaterThanOrEqual(3000)
  })

  it('recordOversized reports only the first time an item is found oversized', () => {
    expect(tracker.recordOversized('item-big' as ItemId, 3000)).toBe(true)
    expect(tracker.recordOversized('item-big' as ItemId, 3000)).toBe(false)

    tracker.clearOversized('item-big' as ItemId)

    expect(tracker['oversizedItems'].has('item-big' as ItemId)).toBe(false)
    expect(tracker.recordOversized('item-big' as ItemId, 3000)).toBe(true)
  })

  it('exports and imports last modified timestamps properly', async () => {
    setTimestamps(tracker, 'item-1', { localModifiedAt: 1000 })
    tracker.recordSnapshotSuccess('item-2' as ItemId, 2000, 0)

    const exported = tracker.exportLastModified()
    expect(exported).toEqual(
      expect.arrayContaining([
        ['item-1', 1000],
        ['item-2', 2000],
      ]),
    )

    const newTracker = new SnapshotTracker({
      lastModifiedStore: mockStore as unknown as LastModifiedStore,
      recoveryManager: mockRecoveryManager,
      session: new SyncSessionState(),
    })

    await newTracker.importLastModified(exported)
    expect(getTimestamps(newTracker, 'item-1').localModifiedAt).toBe(1000)
    expect(getTimestamps(newTracker, 'item-2').lastSnapshotAt).toBe(2000)
  })

  describe('importLastModified', () => {
    it('marks a non-dirty item as in sync even when its stored localModifiedAt is newer', async () => {
      // e.g. a stale timestamp left behind by a remote change
      setTimestamps(tracker, 'item-1', { localModifiedAt: 9000, lastSnapshotAt: 1000 })

      await tracker.importLastModified([['item-1' as ItemId, 5000]])

      expect(getTimestamps(tracker, 'item-1').lastSnapshotAt).toBe(5000)
      expect(getTimestamps(tracker, 'item-1').localModifiedAt).toBe(5000)

      mockStore.loadTimestamps.mockResolvedValue([])
      await tracker.loadLastModified()
      expect(tracker.dirtyCount).toBe(0)
      expect(tracker.getDirtyTick('item-1' as ItemId)).toBeUndefined()
    })

    it('keeps a dirty item pending upload', async () => {
      setTimestamps(tracker, 'item-1', { lastSnapshotAt: 1000 })
      vi.setSystemTime(9000)
      tracker.markItemDirty('item-1' as ItemId)

      await tracker.importLastModified([['item-1' as ItemId, 5000]])

      expect(getTimestamps(tracker, 'item-1').lastSnapshotAt).toBe(1000)
      expect(getTimestamps(tracker, 'item-1').localModifiedAt).toBe(9000)
      expect(tracker.getDirtyTick('item-1' as ItemId)).toBeDefined()
    })

    it('merges new items into the tracked timestamps without purging existing items', async () => {
      await tracker.importLastModified([['item-1' as ItemId, 1000]])
      await tracker.importLastModified([['item-2' as ItemId, 2000]])

      expect(getTimestamps(tracker, 'item-1').localModifiedAt).toBe(1000)
      expect(getTimestamps(tracker, 'item-1').lastSnapshotAt).toBe(1000)
      expect(getTimestamps(tracker, 'item-2').localModifiedAt).toBe(2000)
      expect(getTimestamps(tracker, 'item-2').lastSnapshotAt).toBe(2000)
    })

    it('preserves undefined lastSnapshotAt for newly created unsaved offline items', async () => {
      vi.setSystemTime(5000)
      tracker.markItemDirty('item-new' as ItemId)

      await tracker.importLastModified([['item-new' as ItemId, 5000]])

      expect(getTimestamps(tracker, 'item-new').localModifiedAt).toBe(5000)
      expect(getTimestamps(tracker, 'item-new').lastSnapshotAt).toBeUndefined()
    })

    it('advances lastSnapshotAt when mod is strictly newer than localModifiedAt', async () => {
      setTimestamps(tracker, 'item-1', { localModifiedAt: 2000, lastSnapshotAt: 1000 })

      await tracker.importLastModified([['item-1' as ItemId, 3000]])

      expect(getTimestamps(tracker, 'item-1').localModifiedAt).toBe(3000)
      expect(getTimestamps(tracker, 'item-1').lastSnapshotAt).toBe(3000)
    })

    it('ensures startup dirty audit re-enqueues unsaved offline edits after ManifestSync updates other items', async () => {
      let stored: [ItemId, { localModifiedAt: number; lastSnapshotAt?: number; baseVersion?: number }][] = []
      mockStore.loadTimestamps.mockImplementation(async () => stored)
      mockStore.saveTimestamps.mockImplementation(async (data: typeof stored) => {
        stored = data
      })

      // 1. item-offline has local edits (localMod: 5000, lastSnap: 1000)
      setTimestamps(tracker, 'item-offline', { localModifiedAt: 5000, lastSnapshotAt: 1000 })

      // 2. ManifestSync imports updates for another item
      await tracker.importLastModified([['item-server' as ItemId, 2500]])

      // Verify in-memory state before crash
      expect(getTimestamps(tracker, 'item-offline').lastSnapshotAt).toBe(1000)

      // 3. Worker crashes / restarts -> a fresh tracker reloads from storage
      const restarted = new SnapshotTracker({
        lastModifiedStore: mockStore as unknown as LastModifiedStore,
        recoveryManager: mockRecoveryManager,
        session: new SyncSessionState({ isLeader: true }),
      })
      await restarted.loadLastModified()

      // 4. Dirty audit must successfully re-enqueue item-offline because 5000 > 1000
      expect(restarted.getDirtyItemIds()).toContain('item-offline' as ItemId)
      expect(restarted.getDirtyItemIds()).not.toContain('item-server' as ItemId)
    })
  })

  describe('deleteDirtyItem', () => {
    it('removes item from dirtyItems and clears the due time when dirtyItems becomes empty', async () => {
      tracker.markItemDirty('item-1' as ItemId)
      expect(tracker.getDirtyTick('item-1' as ItemId)).toBeDefined()
      expect(tracker.nextDueAt).toBeDefined()

      const deleted = tracker.deleteDirtyItem('item-1' as ItemId)
      expect(deleted).toBe(true)
      expect(tracker.getDirtyTick('item-1' as ItemId)).toBeUndefined()
      expect(tracker.dirtyCount).toBe(0)

      // A later edit starts a new debounce and max wait rather than inheriting the old ones
      vi.setSystemTime(4000)
      tracker.markItemDirty('item-2' as ItemId)
      expect(tracker.nextDueAt).toBe(5000)
      tracker.deleteDirtyItem('item-2' as ItemId)
      expect(tracker['maxWaitDueAt']).toBeUndefined()
    })

    it('advances lastSnapshotAt to localModifiedAt to prevent startup audit resurrection', async () => {
      vi.setSystemTime(5000)
      tracker.markItemDirty('item-1' as ItemId)
      // item-1 has localMod: 5000 and undefined lastSnapshotAt

      tracker.deleteDirtyItem('item-1' as ItemId)
      expect(getTimestamps(tracker, 'item-1').lastSnapshotAt).toBe(5000)

      // Verify that audit does not restore it
      mockStore.loadTimestamps.mockResolvedValue([
        ['item-1' as ItemId, { localModifiedAt: 5000, lastSnapshotAt: 5000 }],
      ])
      await tracker.loadLastModified()
      expect(tracker.dirtyCount).toBe(0)
      expect(tracker.getDirtyTick('item-1' as ItemId)).toBeUndefined()
    })

    it('returns false when deleting an item that was not dirty', () => {
      expect(tracker.deleteDirtyItem('item-not-dirty' as ItemId)).toBe(false)
    })
  })

  describe('shutdown', () => {
    it('persists the timestamps without clearing the persisted store', async () => {
      await tracker.importLastModified([['item-1' as ItemId, 123456]])
      mockStore.saveTimestamps.mockClear()

      await shutDown()

      expect(mockStore.saveTimestamps).toHaveBeenCalledWith([
        ['item-1', { localModifiedAt: 123456, lastSnapshotAt: 123456, baseVersion: 0 }],
      ])
      expect(mockStore.clear).not.toHaveBeenCalled()
    })

    it('resets in-memory state with clearLocalData without saving or clearing the persisted store', async () => {
      await tracker.importLastModified([['item-1' as ItemId, 123456]])
      tracker.markItemDirty('item-dirty' as ItemId)
      mockStore.saveTimestamps.mockClear()

      await shutDown({ clearLocalData: true })

      expect(tracker.exportLastModified()).toHaveLength(0)
      expect(tracker.dirtyCount).toBe(0)
      expect(mockStore.saveTimestamps).not.toHaveBeenCalled()
      expect(mockStore.clear).not.toHaveBeenCalled()

      // No debounced save fires afterwards
      await vi.advanceTimersByTimeAsync(5000)
      expect(mockStore.saveTimestamps).not.toHaveBeenCalled()
    })

    it('saves dirty items once without leaving a debounced save behind', async () => {
      tracker.markItemDirty('item-1' as ItemId)

      await shutDown()

      expect(mockStore.saveTimestamps).toHaveBeenCalledTimes(1)

      // Advance timers to verify no dangling timer fires
      await vi.advanceTimersByTimeAsync(5000)
      expect(mockStore.saveTimestamps).toHaveBeenCalledTimes(1)
      expect(tracker.nextDueAt).toBeUndefined()
    })

    it('ignores markItemDirty after shutdown', async () => {
      await shutDown()
      mockStore.saveTimestamps.mockClear()

      tracker.markItemDirty('item-after-shutdown' as ItemId)
      await vi.advanceTimersByTimeAsync(5000)

      expect(mockStore.saveTimestamps).not.toHaveBeenCalled()
      expect(tracker.dirtyCount).toBe(0)
    })
  })

  describe('saving timestamps', () => {
    it('saveLastModified throws a failure to save', async () => {
      const quotaError = new DOMException('Quota exceeded', 'QuotaExceededError')
      mockStore.saveTimestamps.mockRejectedValueOnce(quotaError)

      await expect(tracker.saveLastModified()).rejects.toBe(quotaError)
    })

    it('persistLastModified logs a failure to save instead of throwing', async () => {
      mockStore.saveTimestamps.mockRejectedValueOnce(new DOMException('Quota exceeded', 'QuotaExceededError'))

      await expect(tracker['persistLastModified']()).resolves.toBeUndefined()
    })
  })

  describe('persistLastModified across tabs', () => {
    it("keeps the leader's progress when a follower with older state saves", async () => {
      let stored: [ItemId, { localModifiedAt: number; lastSnapshotAt?: number; baseVersion?: number }][] = []
      const sharedStore = {
        loadTimestamps: vi.fn(async () => stored),
        saveTimestamps: vi.fn(async (data: typeof stored) => {
          stored = data
        }),
      } as unknown as LastModifiedStore
      const makeTracker = (isLeader: boolean) => new SnapshotTracker({
        lastModifiedStore: sharedStore,
        recoveryManager: mockRecoveryManager,
        session: new SyncSessionState({ isLeader }),
      })
      const leader = makeTracker(true)
      const follower = makeTracker(false)

      // The follower loaded before the leader uploaded these snapshots
      leader.recordSnapshotSuccess('item-1' as ItemId, 2000, 0, 5)
      leader.recordSnapshotSuccess('item-2' as ItemId, 2000, 0, 3)
      await leader['persistLastModified']()
      setTimestamps(follower, 'item-1', { localModifiedAt: 1000, lastSnapshotAt: 500 })
      setTimestamps(follower, 'item-3', { localModifiedAt: 3000 })
      await follower['persistLastModified']()

      const byId = new Map(stored)
      expect(byId.get('item-1' as ItemId)).toEqual({ localModifiedAt: 2000, lastSnapshotAt: 2000, baseVersion: 5 })
      expect(byId.get('item-2' as ItemId)).toEqual({ localModifiedAt: 2000, lastSnapshotAt: 2000, baseVersion: 3 })
      expect(byId.get('item-3' as ItemId)).toEqual({ localModifiedAt: 3000, lastSnapshotAt: undefined, baseVersion: 0 })
    })
  })
})
