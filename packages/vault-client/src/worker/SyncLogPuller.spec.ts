import type { Mock } from 'vitest'
import type { ItemId, SyncLogEntry } from '@vault/shared'
import type { KeyProvider } from '../keys/Keyring'
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

describe('SyncLogPuller', () => {
  let session: SyncSessionState
  let stored: { cursor: number; lastPullAt: number | null }
  let cursorStore: { load: AnyMock; save: AnyMock }
  let keys: { hasKey: AnyMock; decryptBytes: AnyMock; waitForKey: AnyMock }
  let incoming: { apply: AnyMock }
  let healer: { park: AnyMock; onLogEntry: AnyMock }
  let coverage: { recordPulledChanges: AnyMock; onCursorAdvanced: AnyMock }
  let bus: { publishSyncPing: AnyMock }
  let onRemoteChangesApplied: AnyMock
  let puller: SyncLogPuller

  beforeEach(async () => {
    session = new SyncSessionState({ isLeader: true })
    stored = { cursor: 0, lastPullAt: NOW - 1000 }
    cursorStore = {
      load: vi.fn(async () => stored),
      save: vi.fn(async (position: typeof stored) => {
        stored = { ...position }
      }),
    }
    keys = {
      hasKey: vi.fn().mockReturnValue(true),
      decryptBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
      waitForKey: vi.fn().mockResolvedValue(false),
    }
    incoming = { apply: vi.fn().mockResolvedValue(true) }
    healer = { park: vi.fn().mockResolvedValue(undefined), onLogEntry: vi.fn() }
    coverage = {
      recordPulledChanges: vi.fn().mockResolvedValue(undefined),
      onCursorAdvanced: vi.fn().mockResolvedValue(undefined),
    }
    bus = { publishSyncPing: vi.fn() }
    onRemoteChangesApplied = vi.fn()
    puller = new SyncLogPuller({
      cursorStore: cursorStore as unknown as SyncLogPullerDeps['cursorStore'],
      keys: keys as unknown as KeyProvider,
      session,
      incoming: incoming as unknown as SyncLogPullerDeps['incoming'],
      healer: healer as unknown as SyncLogPullerDeps['healer'],
      coverage: coverage as unknown as SyncLogPullerDeps['coverage'],
      bus: bus as unknown as SyncLogPullerDeps['bus'],
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
    expect(onRemoteChangesApplied).toHaveBeenCalledWith(ITEM)
    expect(bus.publishSyncPing).toHaveBeenCalledWith([ITEM])
    expect(coverage.onCursorAdvanced).toHaveBeenCalledWith(2)
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

    expect(healer.park).toHaveBeenCalledWith(onlyKeyTwoMissing, 'missingKey')
    expect(puller.cursor).toBe(1)
    expect(new MissingKeyError('2').kver).toBe('2')
  })

  it('parks an entry that fails to decrypt and moves on', async () => {
    keys.decryptBytes.mockRejectedValueOnce(new Error('bad tag'))

    await puller.process(page([entry(1), entry(2)]))

    expect(healer.park).toHaveBeenCalledWith(entry(1), 'decryption')
    expect(incoming.apply).toHaveBeenCalledTimes(1)
    expect(puller.cursor).toBe(2)
  })

  it('parks an entry with missing dependencies', async () => {
    incoming.apply.mockResolvedValueOnce(false)

    await puller.process(page([entry(1)]))

    expect(healer.park).toHaveBeenCalledWith(entry(1), 'missingDeps')
    expect(puller.cursor).toBe(1)
    expect(onRemoteChangesApplied).not.toHaveBeenCalled()
  })

  it('parks an entry that fails to apply, such as for an unreadable doc', async () => {
    incoming.apply.mockRejectedValueOnce(new Error('refusing to overwrite'))

    await puller.process(page([entry(1)]))

    expect(healer.park).toHaveBeenCalledWith(entry(1), 'apply')
    expect(puller.cursor).toBe(1)
  })

  it('holds the cursor where parking failed, so the poll fails and the row is read again', async () => {
    incoming.apply.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    healer.park.mockRejectedValueOnce(new Error('quota'))

    await expect(puller.process(page([entry(1), entry(2)]))).rejects.toThrow('quota')

    expect(puller.cursor).toBe(1)
  })

  it('tells the healer about each entry applied for an item', async () => {
    await puller.process(page([entry(1)]))

    expect(healer.onLogEntry).toHaveBeenCalledWith(ITEM)
  })

  it('records items whose docs gained changes', async () => {
    incoming.apply.mockImplementationOnce(async () => {
      puller.onChangesAdded(ITEM)
      return true
    })

    await puller.process(page([entry(1)]))

    expect(coverage.recordPulledChanges).toHaveBeenCalledWith([ITEM])
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
      expect(puller.takeManifestSyncRequest()).toBe(true)
      expect(puller.takeManifestSyncRequest()).toBe(false)
    })

    it('moves past a fresh gap that has lasted the whole wait', async () => {
      await puller.process(page([entry(2)]))

      await puller.process(page([entry(2)], { serverNow: NOW + SYNC_TIMEOUTS.gapWait }))

      expect(puller.cursor).toBe(2)
      expect(puller.takeManifestSyncRequest()).toBe(true)
    })

    it('expects stale gaps while catching up, and asks for no second manifest sync', async () => {
      stored = { cursor: 0, lastPullAt: null }
      const fresh = new SyncLogPuller({
        cursorStore: cursorStore as unknown as SyncLogPullerDeps['cursorStore'],
        keys: keys as unknown as KeyProvider,
        session,
        incoming: incoming as unknown as SyncLogPullerDeps['incoming'],
        healer: healer as unknown as SyncLogPullerDeps['healer'],
        coverage: coverage as unknown as SyncLogPullerDeps['coverage'],
      })
      await fresh.loadState()
      fresh.onCatchUpManifestSynced()

      await fresh.process(page([entry(5, { createdAt: NOW - SYNC_TIMEOUTS.gapWait })]))

      expect(fresh.cursor).toBe(5)
      expect(fresh.takeManifestSyncRequest()).toBe(false)
      await fresh.shutdown({ clearLocalData: true })
    })
  })

  describe('catch-up', () => {
    it('needs a manifest sync with no record of a finished pull', async () => {
      stored = { cursor: 3, lastPullAt: null }
      const fresh = new SyncLogPuller({
        cursorStore: cursorStore as unknown as SyncLogPullerDeps['cursorStore'],
        keys: keys as unknown as KeyProvider,
        session,
        incoming: incoming as unknown as SyncLogPullerDeps['incoming'],
        healer: healer as unknown as SyncLogPullerDeps['healer'],
        coverage: coverage as unknown as SyncLogPullerDeps['coverage'],
      })
      await fresh.loadState()

      expect(fresh.needsCatchUpManifest(NOW)).toBe(true)

      fresh.onCatchUpManifestSynced()
      expect(fresh.needsCatchUpManifest(NOW)).toBe(false)
      await fresh.shutdown({ clearLocalData: true })
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

  it('saves nothing on a shutdown that clears local data', async () => {
    await puller.process(page([entry(1)]))
    cursorStore.save.mockClear()

    await puller.shutdown({ clearLocalData: true })

    expect(cursorStore.save).not.toHaveBeenCalled()
  })
})
