import type { Mock } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { MAX_INCREMENTAL_MESSAGE_BYTES, type ItemId } from '@vault/shared'
import { ChangeOutbox, type ChangeOutboxDeps, type LogExchange, type PendingMark } from './ChangeOutbox'
import { ServerHeads } from './ServerHeads'
import { SyncLogDatabase } from './stores/SyncLogDatabase'
import { SyncSessionState } from './SyncSessionState'
import { SYNC_LOG_STORES } from '../shared/syncLogStorage'
import { SYNC_BATCH_SIZES, SYNC_TIMEOUTS } from '../shared/syncConfig'
import type { KeyProvider } from '../keys/Keyring'

type AnyMock = Mock<(...args: any[]) => any>

const ITEM = 'item-1' as ItemId

function bytes(length: number): Uint8Array {
  return new Uint8Array(length).fill(1)
}

describe('ChangeOutbox', () => {
  let db: SyncLogDatabase
  let session: SyncSessionState
  let serverHeads: ServerHeads
  let docStore: { [K in keyof ChangeOutboxDeps['docStore']]: AnyMock }
  let exchange: Mock<LogExchange>
  let encryptBytes: AnyMock
  let requestSnapshot: AnyMock
  let onMarked: AnyMock
  let awaitingFirstStart: Set<ItemId>
  let canPush: boolean
  let now: number
  let outbox: ChangeOutbox

  /** The server acknowledges every row */
  const acknowledge: LogExchange = async (push, onResults) => {
    await onResults(push.map((message, index) => ({ itemId: message.itemId, seq: index + 1 })))
  }

  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    db = new SyncLogDatabase('account-1')
    session = new SyncSessionState({ isLeader: true })
    serverHeads = new ServerHeads({
      loadSyncedHeads: async () => [],
      saveSyncedHeads: async () => {},
    })
    docStore = {
      readChangesSince: vi.fn().mockResolvedValue({ changes: [bytes(10)], heads: ['head-2'] }),
      hasChangesSince: vi.fn().mockReturnValue(false),
      hasDataInStorage: vi.fn().mockResolvedValue(true),
    }
    exchange = vi.fn(acknowledge)
    encryptBytes = vi.fn(async (data: Uint8Array) => ({ iv: 'iv', cipher: 'c'.repeat(data.byteLength), kver: '1', format: 2 }))
    requestSnapshot = vi.fn()
    onMarked = vi.fn()
    awaitingFirstStart = new Set()
    canPush = true
    now = 1_000
    outbox = new ChangeOutbox({
      db,
      docStore: docStore as unknown as ChangeOutboxDeps['docStore'],
      keys: { encryptBytes } as unknown as KeyProvider,
      session,
      serverHeads,
      isAwaitingFirstStart: itemId => awaitingFirstStart.has(itemId),
      canPush: () => canPush,
      exchange,
      requestSnapshot,
      onMarked,
      now: () => now,
    })
  })

  afterEach(async () => {
    outbox.shutdown()
    await serverHeads.shutdown({ clearLocalData: true })
    await db.close()
  })

  it('marks an item pending and asks for a push', async () => {
    await outbox.mark(ITEM)

    expect(await outbox.listPending()).toEqual([ITEM])
    expect(await outbox.isPending(ITEM)).toBe(true)
    expect(onMarked).toHaveBeenCalledTimes(1)
  })

  describe('mark age', () => {
    it('keeps when an item first had changes waiting, however often it is marked again', async () => {
      await outbox.mark(ITEM)
      const [first] = await outbox.listMarks()
      now = 5_000

      await outbox.markAll([ITEM])

      const [second] = await outbox.listMarks()
      expect(second.createdAt).toBe(1_000)
      expect(second.tick).not.toBe(first.tick)
    })

    it('dates a mark written before marks had an age at the leader\'s next push', async () => {
      docStore.readChangesSince.mockResolvedValue(null)
      await db.put(SYNC_LOG_STORES.outbox, { itemId: ITEM, tick: 1 })
      now = 7_000

      await outbox.pushPending()

      expect(await outbox.listMarks()).toEqual([expect.objectContaining({ itemId: ITEM, createdAt: 7_000 })])
    })
  })

  describe('why a push skipped an item', () => {
    async function markOf(itemId: ItemId): Promise<PendingMark | undefined> {
      return db.get<PendingMark>(SYNC_LOG_STORES.outbox, itemId)
    }

    it('records a change only a snapshot can deliver, once', async () => {
      docStore.readChangesSince.mockResolvedValue({ changes: [bytes(MAX_INCREMENTAL_MESSAGE_BYTES + 1)], heads: ['h'] })
      await outbox.mark(ITEM)
      const update = vi.spyOn(db, 'update')

      await outbox.pushPending()
      await outbox.pushPending()

      expect((await markOf(ITEM))?.blocked).toBe('snapshotOnly')
      const blockedWrites = update.mock.calls.filter(([, keys]) => keys.includes(ITEM))
      expect(blockedWrites).toHaveLength(1)
    })

    it('records a doc that exists but will not load', async () => {
      docStore.readChangesSince.mockResolvedValue(null)
      await outbox.mark(ITEM)

      await outbox.pushPending()

      expect((await markOf(ITEM))?.blocked).toBe('unloadable')
    })

    it('records nothing for an item first start holds, whose own records say why', async () => {
      awaitingFirstStart.add(ITEM)
      await outbox.mark(ITEM)

      await outbox.pushPending()

      expect((await markOf(ITEM))?.blocked).toBeUndefined()
    })
  })

  it('pushes changes encrypted with the item ID, then records the heads and clears the mark', async () => {
    await outbox.mark(ITEM)

    await outbox.pushPending()

    expect(encryptBytes).toHaveBeenCalledWith(expect.any(Uint8Array), ITEM)
    expect(exchange).toHaveBeenCalledTimes(1)
    expect(serverHeads.get(ITEM)).toEqual(['head-2'])
    expect(await outbox.listPending()).toEqual([])
  })

  it('reads changes after the server heads', async () => {
    serverHeads.set(ITEM, ['head-1'])
    await outbox.mark(ITEM)

    await outbox.pushPending()

    expect(docStore.readChangesSince).toHaveBeenCalledWith(ITEM, ['head-1'])
  })

  it('clears a false mark without a request', async () => {
    docStore.readChangesSince.mockResolvedValue({ changes: [], heads: ['head-1'] })
    await outbox.mark(ITEM)

    await outbox.pushPending()

    expect(exchange).not.toHaveBeenCalled()
    expect(await outbox.listPending()).toEqual([])
  })

  it('keeps the mark of an edit made while a push was in flight', async () => {
    await outbox.mark(ITEM)
    exchange.mockImplementationOnce(async (push, onResults) => {
      await outbox.mark(ITEM)
      await acknowledge(push, onResults)
    })

    await outbox.pushPending()

    expect(await outbox.listPending()).toEqual([ITEM])
  })

  it('changes nothing locally when a push fails', async () => {
    await outbox.mark(ITEM)
    exchange.mockRejectedValueOnce(new Error('offline'))

    await expect(outbox.pushPending()).rejects.toThrow('offline')

    expect(serverHeads.has(ITEM)).toBe(false)
    expect(await outbox.listPending()).toEqual([ITEM])
  })

  it('groups changes in order into rows under the limit', async () => {
    const half = MAX_INCREMENTAL_MESSAGE_BYTES / 2
    docStore.readChangesSince.mockResolvedValue({
      changes: [bytes(half), bytes(half), bytes(half)],
      heads: ['head-2'],
    })
    await outbox.mark(ITEM)

    await outbox.pushPending()

    expect(exchange.mock.calls[0][0]).toHaveLength(2)
    expect(encryptBytes.mock.calls.map(([row]) => row.byteLength)).toEqual([half * 2, half])
  })

  it('records nothing until every row of a split set is acknowledged, and a retry resends it all', async () => {
    const rowCount = Math.ceil(SYNC_BATCH_SIZES.logPushChars / MAX_INCREMENTAL_MESSAGE_BYTES) + 2
    const changes = Array.from({ length: rowCount }, () => bytes(MAX_INCREMENTAL_MESSAGE_BYTES))
    docStore.readChangesSince.mockResolvedValue({ changes, heads: ['head-2'] })
    await outbox.mark(ITEM)
    exchange.mockImplementationOnce(acknowledge).mockRejectedValueOnce(new Error('offline'))

    await expect(outbox.pushPending()).rejects.toThrow('offline')

    expect(serverHeads.has(ITEM)).toBe(false)
    expect(await outbox.listPending()).toEqual([ITEM])

    await outbox.pushPending()

    expect(serverHeads.get(ITEM)).toEqual(['head-2'])
    expect(await outbox.listPending()).toEqual([])
    const sent = exchange.mock.calls.slice(2).flatMap(([push]) => push)
    expect(sent).toHaveLength(rowCount)
  })

  it('throws when the server leaves rows unacknowledged', async () => {
    await outbox.mark(ITEM)
    exchange.mockImplementationOnce(async (_push, onResults) => onResults([]))

    await expect(outbox.pushPending()).rejects.toThrow("didn't acknowledge")

    expect(await outbox.listPending()).toEqual([ITEM])
  })

  it('sends a single oversized change by snapshot instead, keeping the mark', async () => {
    docStore.readChangesSince.mockResolvedValue({ changes: [bytes(MAX_INCREMENTAL_MESSAGE_BYTES + 1)], heads: ['head-2'] })
    await outbox.mark(ITEM)

    await outbox.pushPending()

    expect(exchange).not.toHaveBeenCalled()
    expect(requestSnapshot).toHaveBeenCalledWith(ITEM)
    expect(outbox.isSnapshotOnly(ITEM)).toBe(true)
    expect(await outbox.listPending()).toEqual([ITEM])

    outbox.confirmSnapshotOnly(ITEM, ['head-2'])

    expect(outbox.isSnapshotOnly(ITEM)).toBe(false)
    expect(serverHeads.get(ITEM)).toEqual(['head-2'])
  })

  describe('a request the server refuses', () => {
    const OTHER = 'item-2' as ItemId
    const refused = Object.assign(new Error('Invalid input'), { data: { code: 'BAD_REQUEST', httpStatus: 400 } })

    /** The server refuses any request carrying ITEM's rows, and acknowledges the rest */
    const refuseItem: LogExchange = async (push, onResults) => {
      if (push.some(message => message.itemId === ITEM)) throw refused
      await acknowledge(push, onResults)
    }

    it('delivers the item it refuses on its own by snapshot, and pushes the others', async () => {
      exchange.mockImplementation(refuseItem)
      await outbox.mark(ITEM)
      await outbox.mark(OTHER)

      await outbox.pushPending()

      expect(outbox.isSnapshotOnly(ITEM)).toBe(true)
      expect(requestSnapshot).toHaveBeenCalledWith(ITEM)
      expect(serverHeads.get(OTHER)).toEqual(['head-2'])
      // The snapshot carries ITEM's changes, so its mark stays until that's confirmed
      expect(await outbox.listPending()).toEqual([ITEM])

      exchange.mockClear()
      await outbox.pushPending()
      expect(exchange).not.toHaveBeenCalled()
    })

    it('still fails the push on an outage, which a later poll retries', async () => {
      exchange.mockRejectedValue(Object.assign(new Error('Service unavailable'), { data: { httpStatus: 503 } }))
      await outbox.mark(ITEM)

      await expect(outbox.pushPending()).rejects.toThrow('Service unavailable')

      expect(outbox.isSnapshotOnly(ITEM)).toBe(false)
      expect(requestSnapshot).not.toHaveBeenCalled()
    })

    // The account is over its log quota: nothing is wrong with the item, so it mustn't go snapshot-only
    it('still fails the push when the account is over a quota, which a later poll retries', async () => {
      exchange.mockRejectedValue(Object.assign(new Error('QUOTA_EXCEEDED'), {
        data: { code: 'TOO_MANY_REQUESTS', httpStatus: 429 },
      }))
      await outbox.mark(ITEM)

      await expect(outbox.pushPending()).rejects.toThrow('QUOTA_EXCEEDED')

      expect(outbox.isSnapshotOnly(ITEM)).toBe(false)
      expect(requestSnapshot).not.toHaveBeenCalled()
      expect(await outbox.listPending()).toEqual([ITEM])
    })

    it('still fails the push when the server refuses the session', async () => {
      exchange.mockRejectedValue(Object.assign(new Error('UNAUTHORIZED'), { data: { code: 'UNAUTHORIZED', httpStatus: 401 } }))
      await outbox.mark(ITEM)

      await expect(outbox.pushPending()).rejects.toThrow('UNAUTHORIZED')
      expect(outbox.isSnapshotOnly(ITEM)).toBe(false)
    })
  })

  it('never pushes an item waiting on first start, which would send its whole history', async () => {
    awaitingFirstStart.add(ITEM)
    await outbox.mark(ITEM)

    await outbox.pushPending()

    expect(docStore.readChangesSince).not.toHaveBeenCalled()
    expect(await outbox.listPending()).toEqual([ITEM])
  })

  it('pushes nothing until first start allows it', async () => {
    canPush = false
    await outbox.mark(ITEM)

    await outbox.pushPending()

    expect(docStore.readChangesSince).not.toHaveBeenCalled()
  })

  it('keeps the mark of a doc that exists but will not load, and clears one with no doc', async () => {
    docStore.readChangesSince.mockResolvedValue(null)
    await outbox.mark(ITEM)

    await outbox.pushPending()
    expect(await outbox.listPending()).toEqual([ITEM])

    docStore.hasDataInStorage.mockResolvedValue(false)
    await outbox.pushPending()
    expect(await outbox.listPending()).toEqual([])
  })

  it('pushes the given items whether or not they are marked', async () => {
    await outbox.pushItems([ITEM])

    expect(exchange).toHaveBeenCalledTimes(1)
    expect(serverHeads.get(ITEM)).toEqual(['head-2'])
  })

  describe('doc changes', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    async function settleCheck() {
      await vi.advanceTimersByTimeAsync(SYNC_TIMEOUTS.docChangeCheck)
      vi.useRealTimers()
      await new Promise(resolve => setTimeout(resolve, 10))
    }

    it('marks an item the leader finds unpushed, such as a follower\'s change arriving late', async () => {
      docStore.hasChangesSince.mockReturnValue(true)

      outbox.onDocChanged(ITEM)
      await settleCheck()

      expect(await outbox.listPending()).toEqual([ITEM])
    })

    it('leaves an item with nothing unpushed', async () => {
      outbox.onDocChanged(ITEM)
      await settleCheck()

      expect(await outbox.listPending()).toEqual([])
    })

    it('does nothing in a follower', async () => {
      session.setLeader(false)
      docStore.hasChangesSince.mockReturnValue(true)

      outbox.onDocChanged(ITEM)
      await settleCheck()

      expect(docStore.hasChangesSince).not.toHaveBeenCalled()
    })

    it('leaves the mark an item already has, so its tick stays', async () => {
      await db.put(SYNC_LOG_STORES.outbox, { itemId: ITEM, tick: 5 })
      docStore.hasChangesSince.mockReturnValue(true)

      outbox.onDocChanged(ITEM)
      await settleCheck()

      expect(await db.get(SYNC_LOG_STORES.outbox, ITEM)).toEqual({ itemId: ITEM, tick: 5 })
    })
  })
})
