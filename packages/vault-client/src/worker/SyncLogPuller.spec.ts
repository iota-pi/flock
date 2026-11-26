import type { Mock } from 'vitest'
import type { ItemId, SyncLogEntry } from '@vault/shared'
import type { KeyProvider } from '../keys/Keyring'
import type { ManifestDemand } from './ManifestDemands'
import { SyncLogPuller, type LogPage, type SyncLogPullerDeps } from './SyncLogPuller'
import { SyncSessionState } from './SyncSessionState'
import { MissingKeyError } from './utils/decryptWithKeyResolution'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'

type AnyMock = Mock<(...args: any[]) => any>

const ITEM = 'item-1' as ItemId
const NOW = 1_000_000

function entry(seq: number, overrides: Partial<SyncLogEntry> = {}): SyncLogEntry {
  return {
    seq,
    itemId: ITEM,
    encryptedMessage: { iv: 'iv', cipher: `row-${seq}`, kver: '1' },
    createdAt: NOW,
    ...overrides,
  }
}

function page(entries: SyncLogEntry[], overrides: Partial<LogPage> = {}): LogPage {
  return { entries, hasMore: false, serverNow: NOW, ...overrides }
}

/** Holds demands as `ManifestSyncManager` does, and meets them all when a sync fetches the manifest */
class FakeManifest {
  readonly demands = new Set<ManifestDemand>()
  demand(demand: ManifestDemand): void { this.demands.add(demand) }
  isDemanded(demand: ManifestDemand): boolean { return this.demands.has(demand) }
  fetch(): void {
    for (const demand of Array.from(this.demands)) {
      this.demands.delete(demand)
      demand.onFetched?.()
    }
  }
}

describe('SyncLogPuller', () => {
  let session: SyncSessionState
  let stored: { cursor: number; lastPullAt: number | null }
  let cursorStore: { load: AnyMock; save: AnyMock }
  let docs: { flushToStorage: AnyMock }
  let keys: { hasKey: AnyMock; decryptBytes: AnyMock; waitForKey: AnyMock }
  let incoming: { apply: AnyMock; readPending: AnyMock; takeAddedChanges: () => ItemId[]; indexApplied: AnyMock }
  /** Items whose docs gained changes, which `incoming` hands over */
  let addedChanges: Set<ItemId>
  let reconciler: { park: AnyMock; onLogEntry: AnyMock }
  let itemSyncState: { recordPulledChanges: AnyMock; save: AnyMock }
  let onRemoteChangesApplied: AnyMock
  let manifest: FakeManifest
  let puller: SyncLogPuller

  beforeEach(async () => {
    session = new SyncSessionState()
    stored = { cursor: 0, lastPullAt: NOW - 1000 }
    cursorStore = {
      load: vi.fn(async () => stored),
      save: vi.fn(async (position: typeof stored) => {
        stored = { ...position }
      }),
    }
    docs = { flushToStorage: vi.fn().mockResolvedValue(undefined) }
    keys = {
      hasKey: vi.fn().mockReturnValue(true),
      decryptBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
      waitForKey: vi.fn().mockResolvedValue(false),
    }
    addedChanges = new Set()
    incoming = {
      apply: vi.fn().mockResolvedValue(true),
      readPending: vi.fn(async () => new Set<ItemId>()),
      takeAddedChanges: () => {
        const itemIds = Array.from(addedChanges)
        addedChanges.clear()
        return itemIds
      },
      indexApplied: vi.fn().mockResolvedValue(undefined),
    }
    reconciler = { park: vi.fn().mockResolvedValue(undefined), onLogEntry: vi.fn() }
    itemSyncState = {
      recordPulledChanges: vi.fn().mockResolvedValue(undefined),
      save: vi.fn().mockResolvedValue(undefined),
    }
    onRemoteChangesApplied = vi.fn()
    manifest = new FakeManifest()
    puller = new SyncLogPuller({
      cursorStore: cursorStore as unknown as SyncLogPullerDeps['cursorStore'],
      docs,
      keys: keys as unknown as KeyProvider,
      session,
      incoming: incoming as unknown as SyncLogPullerDeps['incoming'],
      reconciler: reconciler as unknown as SyncLogPullerDeps['reconciler'],
      manifest,
      itemSyncState: itemSyncState as unknown as SyncLogPullerDeps['itemSyncState'],
      onRemoteChangesApplied,
    })
    await puller.loadState()
  })

  afterEach(async () => {
    await puller.shutdown({ clearLocalData: true })
  })

  it('applies entries in seq order, decrypted with their item ID, and advances the cursor', async () => {
    await puller.process(page([entry(2), entry(1)]))

    expect(keys.decryptBytes.mock.calls.map(([payload]) => payload.cipher)).toEqual(['row-1', 'row-2'])
    expect(keys.decryptBytes).toHaveBeenCalledWith(expect.anything(), ITEM, undefined)
    expect(puller.cursor).toBe(2)
    expect(onRemoteChangesApplied).toHaveBeenCalledExactlyOnceWith([ITEM])
  })

  it('reads the pending marks once a page and gives every row the same set', async () => {
    const OTHER = 'item-2' as ItemId
    const pending = new Set([OTHER])
    incoming.readPending.mockResolvedValue(pending)

    await puller.process(page([entry(1), entry(2, { itemId: OTHER }), entry(3)]))

    expect(incoming.readPending).toHaveBeenCalledTimes(1)
    expect(incoming.apply.mock.calls.map(([itemId, , marks]) => [itemId, marks])).toEqual([
      [ITEM, pending],
      [OTHER, pending],
      [ITEM, pending],
    ])
    expect(onRemoteChangesApplied).toHaveBeenCalledExactlyOnceWith([ITEM, OTHER])

    await puller.process(page([entry(4)]))
    expect(incoming.readPending).toHaveBeenCalledTimes(2)
  })

  it("doesn't read the pending marks for a page of its own rows", async () => {
    puller.recordOwnPushes([{ itemId: ITEM, seq: 1 }])

    await puller.process(page([entry(1)]))

    expect(incoming.readPending).not.toHaveBeenCalled()
  })

  it('fails the page, without parking, if the pending marks fail to read', async () => {
    incoming.readPending.mockRejectedValueOnce(new Error('idb failed'))

    await expect(puller.process(page([entry(1), entry(2)]))).rejects.toThrow('idb failed')

    expect(reconciler.park).not.toHaveBeenCalled()
    expect(incoming.apply).not.toHaveBeenCalled()
    expect(puller.cursor).toBe(0)
  })

  it('reports only the items whose rows applied', async () => {
    const OTHER = 'item-2' as ItemId
    incoming.apply.mockImplementation(async (itemId: ItemId) => itemId === ITEM)

    await puller.process(page([entry(1), entry(2, { itemId: OTHER })]))

    expect(onRemoteChangesApplied).toHaveBeenCalledExactlyOnceWith([ITEM])
  })

  it('skips entries it has already processed', async () => {
    await puller.process(page([entry(1)]))
    incoming.apply.mockClear()

    await puller.process(page([entry(1), entry(2)]))

    expect(incoming.apply).toHaveBeenCalledTimes(1)
  })

  it('only advances the cursor for a row this device pushed, which counts as its own', async () => {
    puller.recordOwnPushes([{ itemId: ITEM, seq: 1 }])

    await puller.process(page([entry(1)]))

    expect(puller.cursor).toBe(1)
    expect(keys.decryptBytes).not.toHaveBeenCalled()
    expect(onRemoteChangesApplied).not.toHaveBeenCalled()
  })

  it('parks an entry with a missing key and moves on', async () => {
    keys.hasKey.mockReturnValue(false)
    const onlyKeyTwoMissing = entry(1, { encryptedMessage: { iv: 'iv', cipher: 'row-1', kver: '2' } })

    await puller.process(page([onlyKeyTwoMissing]))

    expect(reconciler.park).toHaveBeenCalledWith(onlyKeyTwoMissing, 'missingKey')
    expect(puller.cursor).toBe(1)
    expect(new MissingKeyError('2').kver).toBe('2')
  })

  it('parks an entry that fails to decrypt and moves on', async () => {
    keys.decryptBytes.mockRejectedValueOnce(new Error('bad tag'))

    await puller.process(page([entry(1), entry(2)]))

    expect(reconciler.park).toHaveBeenCalledWith(entry(1), 'decryption')
    expect(incoming.apply).toHaveBeenCalledTimes(1)
    expect(puller.cursor).toBe(2)
  })

  it('parks an entry with missing dependencies', async () => {
    incoming.apply.mockResolvedValueOnce(false)

    await puller.process(page([entry(1)]))

    expect(reconciler.park).toHaveBeenCalledWith(entry(1), 'missingDeps')
    expect(puller.cursor).toBe(1)
    expect(onRemoteChangesApplied).not.toHaveBeenCalled()
  })

  it('parks an entry that fails to apply, such as for an unreadable doc', async () => {
    incoming.apply.mockRejectedValueOnce(new Error('refusing to overwrite'))

    await puller.process(page([entry(1)]))

    expect(reconciler.park).toHaveBeenCalledWith(entry(1), 'apply')
    expect(puller.cursor).toBe(1)
  })

  it('holds the cursor where parking failed, so the poll fails and the row is read again', async () => {
    incoming.apply.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    reconciler.park.mockRejectedValueOnce(new Error('quota'))

    await expect(puller.process(page([entry(1), entry(2)]))).rejects.toThrow('quota')

    expect(puller.cursor).toBe(1)
  })

  it('tells the reconciler about each entry applied for an item', async () => {
    await puller.process(page([entry(1)]))

    expect(reconciler.onLogEntry).toHaveBeenCalledWith(ITEM)
  })

  it('records items whose docs gained changes', async () => {
    incoming.apply.mockImplementationOnce(async () => {
      addedChanges.add(ITEM)
      return true
    })

    await puller.process(page([entry(1)]))

    expect(itemSyncState.recordPulledChanges).toHaveBeenCalledWith([ITEM])
  })

  it('indexes the items a page applied once the page is done', async () => {
    await puller.process(page([entry(1), entry(2)]))

    expect(incoming.indexApplied).toHaveBeenCalledTimes(1)
    expect(incoming.indexApplied.mock.invocationCallOrder[0])
      .toBeGreaterThan(Math.max(...incoming.apply.mock.invocationCallOrder))
  })

  it('fails the page when indexing fails to store', async () => {
    incoming.indexApplied.mockRejectedValueOnce(new Error('disk full'))

    await expect(puller.process(page([entry(1)]))).rejects.toThrow('disk full')
  })

  describe('gaps', () => {
    it('waits at a fresh gap, with a growing delay and never at once', async () => {
      await puller.process(page([entry(2)], { hasMore: true }))

      expect(puller.cursor).toBe(0)
      expect(puller.gapRepollDelay).toBe(SYNC_TIMEOUTS.gapRepollBase)
      expect(puller.hasImmediatePendingPulls()).toBe(false)

      await puller.process(page([entry(2)], { serverNow: NOW + 1000 }))

      expect(puller.gapRepollDelay).toBe(SYNC_TIMEOUTS.gapRepollBase * 2)
      expect(keys.decryptBytes).not.toHaveBeenCalled()
    })

    it('applies both rows in order once the missing one is visible', async () => {
      await puller.process(page([entry(2)]))

      await puller.process(page([entry(1), entry(2)], { serverNow: NOW + 1000 }))

      expect(puller.cursor).toBe(2)
      expect(puller.gapRepollDelay).toBeUndefined()
    })

    it('moves past a gap whose next row is old, logs it and asks for a manifest sync', async () => {
      await puller.process(page([entry(3, { createdAt: NOW - SYNC_TIMEOUTS.gapWait })]))

      expect(puller.cursor).toBe(3)
      expect(puller.gapRepollDelay).toBeUndefined()
      expect(manifest.demands).toEqual(new Set([puller.recoveryDemand]))
      expect(puller.recoveryDemand.beforeRead).toBe(false)
    })

    it('keeps asking for the recovery sync until one fetches the manifest', async () => {
      await puller.process(page([entry(3, { createdAt: NOW - SYNC_TIMEOUTS.gapWait })]))
      await puller.process(page([entry(4)]))

      expect(manifest.isDemanded(puller.recoveryDemand)).toBe(true)

      manifest.fetch()
      expect(manifest.isDemanded(puller.recoveryDemand)).toBe(false)
    })

    it('moves past a fresh gap that has lasted the whole wait', async () => {
      await puller.process(page([entry(2)]))

      await puller.process(page([entry(2)], { serverNow: NOW + SYNC_TIMEOUTS.gapWait }))

      expect(puller.cursor).toBe(2)
      expect(manifest.isDemanded(puller.recoveryDemand)).toBe(true)
    })

    it('expects stale gaps while catching up, and asks for no second manifest sync', async () => {
      stored = { cursor: 0, lastPullAt: null }
      const fresh = new SyncLogPuller({
        cursorStore: cursorStore as unknown as SyncLogPullerDeps['cursorStore'],
        docs,
        keys: keys as unknown as KeyProvider,
        session,
        incoming: incoming as unknown as SyncLogPullerDeps['incoming'],
        reconciler: reconciler as unknown as SyncLogPullerDeps['reconciler'],
        manifest,
        itemSyncState: itemSyncState as unknown as SyncLogPullerDeps['itemSyncState'],
      })
      await fresh.loadState()
      expect(fresh.demandCatchUpIfBehind(NOW)).toBe(true)
      manifest.fetch()

      await fresh.process(page([entry(5, { createdAt: NOW - SYNC_TIMEOUTS.gapWait })]))

      expect(fresh.cursor).toBe(5)
      expect(manifest.demands.size).toBe(0)
      await fresh.shutdown({ clearLocalData: true })
    })
  })

  describe('catch-up', () => {
    it('needs a manifest sync with no record of a finished pull', async () => {
      stored = { cursor: 3, lastPullAt: null }
      const fresh = new SyncLogPuller({
        cursorStore: cursorStore as unknown as SyncLogPullerDeps['cursorStore'],
        docs,
        keys: keys as unknown as KeyProvider,
        session,
        incoming: incoming as unknown as SyncLogPullerDeps['incoming'],
        reconciler: reconciler as unknown as SyncLogPullerDeps['reconciler'],
        manifest,
        itemSyncState: itemSyncState as unknown as SyncLogPullerDeps['itemSyncState'],
      })
      await fresh.loadState()

      expect(fresh.needsCatchUpManifest(NOW)).toBe(true)
      expect(fresh.isCaughtUp).toBe(false)

      expect(fresh.demandCatchUpIfBehind(NOW)).toBe(true)
      expect(manifest.demands).toEqual(new Set([fresh.catchUpDemand]))
      expect(fresh.catchUpDemand.beforeRead).toBe(true)

      const caughtUp = fresh.whenCaughtUp()
      manifest.fetch()
      await caughtUp
      expect(fresh.needsCatchUpManifest(NOW)).toBe(false)
      expect(fresh.demandCatchUpIfBehind(NOW)).toBe(false)
      await fresh.shutdown({ clearLocalData: true })
    })

    it('drops a page when the server clock shows it is behind, and reads again at once after catching up', async () => {
      const behind = page([entry(1)], { serverNow: NOW - 1000 + SYNC_TIMEOUTS.logCatchUpAge + 1 })

      expect(puller.dropPageIfBehind(behind)).toBe(true)
      expect(puller.hasImmediatePendingPulls()).toBe(true)
      expect(manifest.isDemanded(puller.catchUpDemand)).toBe(true)
      // Demanded, so it's due whatever the local clock says
      expect(puller.needsCatchUpManifest(NOW)).toBe(true)

      manifest.fetch()
      expect(puller.dropPageIfBehind(behind)).toBe(false)
    })

    it('stays caught up until the end of the log, then goes by the last finished pull', async () => {
      stored = { cursor: 0, lastPullAt: null }
      await puller.shutdown({ clearLocalData: true })
      const fresh = new SyncLogPuller({
        cursorStore: cursorStore as unknown as SyncLogPullerDeps['cursorStore'],
        docs,
        keys: keys as unknown as KeyProvider,
        session,
        incoming: incoming as unknown as SyncLogPullerDeps['incoming'],
        reconciler: reconciler as unknown as SyncLogPullerDeps['reconciler'],
        manifest,
        itemSyncState: itemSyncState as unknown as SyncLogPullerDeps['itemSyncState'],
      })
      puller = fresh
      await fresh.loadState()
      fresh.demandCatchUpIfBehind(NOW)
      manifest.fetch()

      await fresh.process(page([entry(1)], { hasMore: true }))
      expect(fresh.needsCatchUpManifest(NOW + SYNC_TIMEOUTS.logCatchUpAge * 2)).toBe(false)

      await fresh.process(page([entry(2)]))
      expect(fresh.needsCatchUpManifest(NOW)).toBe(false)
      expect(fresh.needsCatchUpManifest(NOW + SYNC_TIMEOUTS.logCatchUpAge + 1)).toBe(true)
    })

    it('needs one when the last finished pull is older than the catch-up age', () => {
      expect(puller.needsCatchUpManifest(NOW)).toBe(false)
      expect(puller.needsCatchUpManifest(NOW - 1000 + SYNC_TIMEOUTS.logCatchUpAge + 1)).toBe(true)
    })

    it('records a finished pull only when the log has no more rows', async () => {
      await puller.process(page([entry(1)], { hasMore: true, serverNow: NOW + 5000 }))
      await puller.shutdown()
      expect(stored.lastPullAt).toBe(NOW - 1000)

      await puller.process(page([entry(2)], { serverNow: NOW + 6000 }))
      await puller.shutdown()
      expect(stored).toEqual({ cursor: 2, lastPullAt: NOW + 6000 })
    })
  })

  it('polls again at once only for more rows', async () => {
    await puller.process(page([entry(1)], { hasMore: true }))
    expect(puller.hasImmediatePendingPulls()).toBe(true)

    await puller.process(page([entry(2)]))
    expect(puller.hasImmediatePendingPulls()).toBe(false)
  })

  it('keeps the further of its own cursor and the stored one', async () => {
    await puller.process(page([entry(1), entry(2)]))
    stored = { cursor: 1, lastPullAt: NOW }

    await puller.loadState()

    expect(puller.cursor).toBe(2)
  })

  describe('saving the cursor', () => {
    it('stores the docs pulled rows were applied to before saving the cursor', async () => {
      const order: string[] = []
      docs.flushToStorage.mockImplementation(async (itemIds: ItemId[]) => {
        order.push(`flush:${itemIds.join(',')}`)
      })
      cursorStore.save.mockImplementation(async (position: typeof stored) => {
        order.push(`save:${position.cursor}`)
        stored = { ...position }
      })
      const other = 'item-2' as ItemId
      puller.recordOwnPushes([{ itemId: other, seq: 3 }])

      await puller.process(page([entry(1), entry(2, { itemId: other }), entry(3, { itemId: other })]))
      await puller.shutdown()

      expect(order).toEqual([`flush:${ITEM},${other}`, 'save:3'])
    })

    it("doesn't save the cursor if a doc fails to store, and stores it again next time", async () => {
      docs.flushToStorage.mockRejectedValueOnce(new Error('QuotaExceededError'))
      await puller.process(page([entry(1)]))
      await puller.shutdown()

      expect(cursorStore.save).not.toHaveBeenCalled()
      expect(stored.cursor).toBe(0)

      await puller.process(page([entry(2)]))
      await puller.shutdown()

      expect(docs.flushToStorage).toHaveBeenLastCalledWith([ITEM])
      expect(stored.cursor).toBe(2)
    })

    it('stores the S2 records for pulled changes before saving the cursor', async () => {
      const order: string[] = []
      incoming.apply.mockImplementationOnce(async () => {
        addedChanges.add(ITEM)
        return true
      })
      itemSyncState.recordPulledChanges.mockImplementation(async (itemIds: ItemId[]) => {
        order.push(`record:${itemIds.join(',')}`)
      })
      itemSyncState.save.mockImplementation(async () => {
        order.push('records')
      })
      cursorStore.save.mockImplementation(async (position: typeof stored) => {
        order.push(`save:${position.cursor}`)
        stored = { ...position }
      })

      await puller.process(page([entry(1)]))
      await puller.shutdown()

      expect(order).toEqual([`record:${ITEM}`, 'records', 'save:1'])
    })

    it("doesn't save the cursor if the S2 records fail to store, and stores it again next time", async () => {
      itemSyncState.save.mockRejectedValueOnce(new Error('QuotaExceededError'))
      await puller.process(page([entry(1)]))
      await puller.shutdown()

      expect(cursorStore.save).not.toHaveBeenCalled()
      expect(stored.cursor).toBe(0)

      await puller.process(page([entry(2)]))
      await puller.shutdown()

      expect(stored.cursor).toBe(2)
    })

    it('records pulled changes from a page that fails part way, before the cursor can be saved', async () => {
      incoming.apply.mockImplementationOnce(async () => {
        addedChanges.add(ITEM)
        return true
      }).mockResolvedValueOnce(false)
      reconciler.park.mockRejectedValueOnce(new Error('quota'))

      await expect(puller.process(page([entry(1), entry(2)]))).rejects.toThrow('quota')
      await puller.shutdown()

      expect(itemSyncState.recordPulledChanges).toHaveBeenCalledWith([ITEM])
      expect(itemSyncState.recordPulledChanges.mock.invocationCallOrder[0])
        .toBeLessThan(itemSyncState.save.mock.invocationCallOrder[0])
      expect(stored.cursor).toBe(1)
    })

    it("doesn't store a doc again once a saved cursor covers it", async () => {
      await puller.process(page([entry(1)]))
      await puller.shutdown()

      await puller.process(page([entry(2, { itemId: 'item-2' as ItemId })]))
      await puller.shutdown()

      expect(docs.flushToStorage).toHaveBeenLastCalledWith(['item-2'])
      expect(stored.cursor).toBe(2)
    })

    // Its push read the changes from the doc in memory, and if they never reached storage, the row is
    // what brings them back after a crash
    it("doesn't save the cursor past its own row until that row's doc is stored", async () => {
      puller.recordOwnPushes([{ itemId: ITEM, seq: 1 }])
      docs.flushToStorage.mockRejectedValueOnce(new Error('QuotaExceededError'))
      await puller.process(page([entry(1)]))
      await puller.shutdown()

      expect(puller.cursor).toBe(1)
      expect(docs.flushToStorage).toHaveBeenLastCalledWith([ITEM])
      expect(cursorStore.save).not.toHaveBeenCalled()
      expect(stored.cursor).toBe(0)
    })
  })

  it('saves nothing on a shutdown that clears local data', async () => {
    await puller.process(page([entry(1)]))
    cursorStore.save.mockClear()

    await puller.shutdown({ clearLocalData: true })

    expect(cursorStore.save).not.toHaveBeenCalled()
  })
})
