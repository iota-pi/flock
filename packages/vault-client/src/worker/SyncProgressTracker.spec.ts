import { SyncProgressTracker } from './SyncProgressTracker'
import { ClientEventHub } from './SyncEventHub'
import type { LastSyncedStore } from './stores/LastSyncedStore'
import type { SyncProgress, UnsyncedChanges } from '../shared/types'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'

describe('SyncProgressTracker', () => {
  let eventHub: ClientEventHub
  let stored: number | null
  let store: LastSyncedStore
  let changes: UnsyncedChanges
  let countUnsyncedChanges: ReturnType<typeof vi.fn<() => Promise<UnsyncedChanges>>>
  let now: number
  let emitted: SyncProgress[]
  let tracker: SyncProgressTracker

  async function settle(): Promise<void> {
    await vi.advanceTimersByTimeAsync(SYNC_TIMEOUTS.syncProgressDebounce)
  }

  beforeEach(() => {
    vi.useFakeTimers()
    eventHub = new ClientEventHub()
    stored = null
    store = {
      load: vi.fn(async () => stored),
      save: vi.fn(async (timestamp: number) => {
        stored = timestamp
      }),
    } as unknown as LastSyncedStore
    changes = { pendingItems: 0, quarantinedItems: 0 }
    countUnsyncedChanges = vi.fn(async () => changes)
    now = 1_000_000
    emitted = []
    eventHub.subscribe(event => {
      if (event.type === 'syncProgress') emitted.push(event.progress)
    })
    tracker = new SyncProgressTracker({ eventHub, store, countUnsyncedChanges, now: () => now })
  })

  afterEach(() => {
    tracker.stop()
    vi.useRealTimers()
  })

  it('emits the counts and the stored last sync time on start', async () => {
    stored = 500
    changes = { pendingItems: 2, quarantinedItems: 1 }

    await tracker.start()
    await settle()

    expect(emitted).toEqual([{ pendingItems: 2, quarantinedItems: 1, lastSyncedAt: 500 }])
  })

  it('records and saves the time of a successful poll', async () => {
    await tracker.start()
    await settle()

    tracker.onPollResult('success')
    await settle()

    expect(store.save).toHaveBeenCalledWith(now)
    expect(emitted.at(-1)).toEqual({ pendingItems: 0, quarantinedItems: 0, lastSyncedAt: now })
  })

  it('recounts after a failed poll without changing the last sync time', async () => {
    stored = 500
    await tracker.start()
    await settle()

    changes = { pendingItems: 3, quarantinedItems: 0 }
    tracker.onPollResult('failure')
    await settle()

    expect(store.save).not.toHaveBeenCalled()
    expect(emitted.at(-1)).toEqual({ pendingItems: 3, quarantinedItems: 0, lastSyncedAt: 500 })
  })

  it('recounts after events that may change the counts, debounced', async () => {
    await tracker.start()
    await settle()
    countUnsyncedChanges.mockClear()

    changes = { pendingItems: 1, quarantinedItems: 0 }
    eventHub.emit({ type: 'itemUpdated', id: 'item-1', item: null })
    eventHub.emit({ type: 'finishRequest' })
    await settle()

    expect(countUnsyncedChanges).toHaveBeenCalledTimes(1)
    expect(emitted.at(-1)?.pendingItems).toBe(1)
  })

  it('does not emit when nothing changed', async () => {
    await tracker.start()
    await settle()

    eventHub.emit({ type: 'finishRequest' })
    await settle()

    expect(emitted).toHaveLength(1)
  })

  it("picks up another tab's later sync on the periodic recount", async () => {
    stored = 500
    await tracker.start()
    await settle()

    stored = 900
    changes = { pendingItems: 0, quarantinedItems: 0 }
    await vi.advanceTimersByTimeAsync(SYNC_TIMEOUTS.syncProgressInterval + SYNC_TIMEOUTS.syncProgressDebounce)

    expect(emitted.at(-1)?.lastSyncedAt).toBe(900)
  })

  it('keeps its own later sync time over an older stored one', async () => {
    await tracker.start()
    await settle()
    vi.mocked(store.save).mockImplementation(async () => {})
    stored = 10

    tracker.onPollResult('success')
    await settle()

    expect(emitted.at(-1)?.lastSyncedAt).toBe(now)
  })

  it('runs a recount asked for during one after it, so the latest counts win', async () => {
    await tracker.start()
    await settle()

    let release!: () => void
    countUnsyncedChanges.mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve({ pendingItems: 5, quarantinedItems: 0 })
    }))
    const first = tracker.recount()
    changes = { pendingItems: 1, quarantinedItems: 0 }
    const second = tracker.recount()
    release()
    await Promise.all([first, second])

    expect(emitted.at(-1)?.pendingItems).toBe(1)
  })

  it('emits nothing after stopping', async () => {
    await tracker.start()
    await settle()
    tracker.stop()

    changes = { pendingItems: 4, quarantinedItems: 0 }
    tracker.onPollResult('failure')
    await vi.advanceTimersByTimeAsync(SYNC_TIMEOUTS.syncProgressInterval * 2)

    expect(emitted).toHaveLength(1)
  })

  it('keeps going when counting fails', async () => {
    countUnsyncedChanges.mockRejectedValueOnce(new Error('IndexedDB closed'))
    await tracker.start()
    await settle()
    expect(emitted).toHaveLength(0)

    tracker.onPollResult('no-poll')
    await settle()

    expect(emitted).toHaveLength(1)
  })
})
