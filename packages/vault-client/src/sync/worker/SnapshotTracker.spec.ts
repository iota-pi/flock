import { SnapshotTracker } from './SnapshotTracker'
import { ItemId, MAX_ITEM_SIZE_KB } from '@vault/shared'
import { LastModifiedStore, type ItemSyncTimestamps } from './stores/LastModifiedStore'

/** Sets some of an item's tracked timestamps directly */
function setTimestamps(tracker: SnapshotTracker, itemId: string, timestamps: Partial<ItemSyncTimestamps>): void {
  const byItemId = tracker['timestampsByItemId']
  byItemId.set(itemId as ItemId, { ...byItemId.get(itemId as ItemId), ...timestamps })
}

/** An item's tracked timestamps, empty if it has none */
function getTimestamps(tracker: SnapshotTracker, itemId: string): Partial<ItemSyncTimestamps> {
  return tracker['timestampsByItemId'].get(itemId as ItemId) ?? {}
}

describe('SnapshotTracker', () => {
  let tracker: SnapshotTracker
  let mockStore: any
  let mockRecoveryManager: any
  let onTriggerPush: ReturnType<typeof vi.fn<() => void>>

  beforeEach(() => {
    vi.useFakeTimers()
    onTriggerPush = vi.fn<() => void>()
    mockStore = {
      loadTimestamps: vi.fn().mockResolvedValue([]),
      saveTimestamps: vi.fn().mockResolvedValue(undefined),
    }
    mockRecoveryManager = {
      listRecoveryItems: vi.fn().mockResolvedValue([]),
    }

    tracker = new SnapshotTracker({
      lastModifiedStore: mockStore as unknown as LastModifiedStore,
      recoveryManager: mockRecoveryManager,
      debounceDelayMs: 1000,
      maxWaitMs: 5000,
      isLeader: true,
      onTriggerPush: () => onTriggerPush(),
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('marks items dirty with monotonic tick and triggers push on debounce expiry', async () => {
    tracker.markItemDirty('item-1' as ItemId)
    expect(tracker.getDirtyTick('item-1' as ItemId)).toBe(1)
    expect(tracker.dirtyCount).toBe(1)

    tracker.markItemDirty('item-2' as ItemId)
    expect(tracker.getDirtyTick('item-2' as ItemId)).toBe(2)
    expect(tracker.dirtyCount).toBe(2)

    expect(onTriggerPush).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1000)

    expect(onTriggerPush).toHaveBeenCalledTimes(1)
    expect(tracker.debounceTimer).toBeNull()
  })

  it('triggers on maxWait timer even if debounce is continuously reset', async () => {
    tracker.markItemDirty('item-1' as ItemId)

    // Advance 800ms (< 1000ms debounce)
    await vi.advanceTimersByTimeAsync(800)
    expect(onTriggerPush).not.toHaveBeenCalled()

    // Reset debounce
    tracker.markItemDirty('item-2' as ItemId)
    await vi.advanceTimersByTimeAsync(800)
    expect(onTriggerPush).not.toHaveBeenCalled()

    tracker.markItemDirty('item-3' as ItemId)
    await vi.advanceTimersByTimeAsync(800)
    expect(onTriggerPush).not.toHaveBeenCalled()

    // Now advance past 5000ms total from start
    await vi.advanceTimersByTimeAsync(3000)
    expect(onTriggerPush).toHaveBeenCalledTimes(1)
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
      { itemId: 'item-rate-limited', reason: 'Push failed after 5 consecutive attempts: Rate limit exceeded', kind: 'pushFailure' },
    ])

    await tracker.loadLastModified()

    expect(tracker.dirtyCount).toBe(1) // Only item-clean restored
    expect(tracker.dirtyItems.has('item-clean' as ItemId)).toBe(true)
    expect(tracker.dirtyItems.has('item-synced' as ItemId)).toBe(false)
    expect(tracker.dirtyItems.has('item-quarantined' as ItemId)).toBe(false)
    expect(tracker.oversizedItems.has('item-oversized' as ItemId)).toBe(true)
    expect(tracker.oversizedItems.has('item-rate-limited' as ItemId)).toBe(false)
  })

  it('loads once for callers that join a load in flight', async () => {
    mockRecoveryManager.listRecoveryItems.mockResolvedValue([
      { itemId: 'item-oversized', reason: `Snapshot size exceeds ${MAX_ITEM_SIZE_KB} KB limit`, kind: 'oversized' },
    ])

    await Promise.all([tracker.loadLastModified(), tracker.loadLastModified()])

    expect(mockStore.loadTimestamps).toHaveBeenCalledTimes(1)
    expect([...tracker.oversizedItems]).toEqual(['item-oversized'])
  })

  it('recordSnapshotSuccess clears matching tick and updates lastSnapshotAt', () => {
    tracker.markItemDirty('item-1' as ItemId)
    const tick = tracker.getDirtyTick('item-1' as ItemId)!

    tracker.recordSnapshotSuccess('item-1' as ItemId, 2000, tick)

    expect(tracker.dirtyItems.has('item-1' as ItemId)).toBe(false)
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

    expect(tracker.dirtyItems.has('item-1' as ItemId)).toBe(true)
    expect(getTimestamps(tracker, 'item-1').lastSnapshotAt).toBe(2000)
  })

  it('recordOversized removes item from dirty queue and advances lastSnapshotAt', () => {
    tracker.markItemDirty('item-big' as ItemId)
    tracker.recordOversized('item-big' as ItemId, 3000)

    expect(tracker.dirtyItems.has('item-big' as ItemId)).toBe(false)
    expect(getTimestamps(tracker, 'item-big').lastSnapshotAt).toBeGreaterThanOrEqual(3000)
  })

  it('recordOversized reports only the first time an item is found oversized', () => {
    expect(tracker.recordOversized('item-big' as ItemId, 3000)).toBe(true)
    expect(tracker.recordOversized('item-big' as ItemId, 3000)).toBe(false)

    tracker.clearOversized('item-big' as ItemId)

    expect(tracker.oversizedItems.has('item-big' as ItemId)).toBe(false)
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
      expect(tracker.dirtyItems.has('item-1' as ItemId)).toBe(false)
    })

    it('keeps a dirty item pending upload', async () => {
      setTimestamps(tracker, 'item-1', { lastSnapshotAt: 1000 })
      vi.setSystemTime(9000)
      tracker.markItemDirty('item-1' as ItemId)

      await tracker.importLastModified([['item-1' as ItemId, 5000]])

      expect(getTimestamps(tracker, 'item-1').lastSnapshotAt).toBe(1000)
      expect(getTimestamps(tracker, 'item-1').localModifiedAt).toBe(9000)
      expect(tracker.dirtyItems.has('item-1' as ItemId)).toBe(true)
    })
  })

  describe('deleteDirtyItem', () => {
    it('removes item from dirtyItems and clears timers when dirtyItems becomes empty', () => {
      tracker.markItemDirty('item-1' as ItemId)
      expect(tracker.dirtyItems.has('item-1' as ItemId)).toBe(true)
      expect(tracker.debounceTimer).not.toBeNull()

      const deleted = tracker.deleteDirtyItem('item-1' as ItemId)
      expect(deleted).toBe(true)
      expect(tracker.dirtyItems.has('item-1' as ItemId)).toBe(false)
      expect(tracker.dirtyCount).toBe(0)
      expect(tracker.debounceTimer).toBeNull()
      expect(tracker.maxWaitTimer).toBeNull()
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
      expect(tracker.dirtyItems.has('item-1' as ItemId)).toBe(false)
    })

    it('returns false when deleting an item that was not dirty', () => {
      expect(tracker.deleteDirtyItem('item-not-dirty' as ItemId)).toBe(false)
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
        isLeader,
      })
      const leader = makeTracker(true)
      const follower = makeTracker(false)

      // The follower loaded before the leader uploaded these snapshots
      leader.recordSnapshotSuccess('item-1' as ItemId, 2000, 0, 5)
      leader.recordSnapshotSuccess('item-2' as ItemId, 2000, 0, 3)
      await leader.persistLastModified()
      setTimestamps(follower, 'item-1', { localModifiedAt: 1000, lastSnapshotAt: 500 })
      setTimestamps(follower, 'item-3', { localModifiedAt: 3000 })
      await follower.persistLastModified()

      const byId = new Map(stored)
      expect(byId.get('item-1' as ItemId)).toEqual({ localModifiedAt: 2000, lastSnapshotAt: 2000, baseVersion: 5 })
      expect(byId.get('item-2' as ItemId)).toEqual({ localModifiedAt: 2000, lastSnapshotAt: 2000, baseVersion: 3 })
      expect(byId.get('item-3' as ItemId)).toEqual({ localModifiedAt: 3000, lastSnapshotAt: undefined, baseVersion: 0 })
    })
  })
})
