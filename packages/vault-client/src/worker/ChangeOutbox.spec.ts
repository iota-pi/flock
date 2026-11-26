import type { Mock } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { MAX_INCREMENTAL_MESSAGE_BYTES, type ItemId } from '@vault/shared'
import { ChangeOutbox, readPendingMarks, type ChangeOutboxDeps, type PendingMark } from './ChangeOutbox'
import type { LogExchange } from './LogExchange'
import { ItemSyncState } from './ItemSyncState'
import { SyncLogDatabase } from './stores/SyncLogDatabase'
import { SyncSessionState } from './SyncSessionState'
import { SYNC_LOG_STORES } from '../shared/syncLogStorage'
import { SYNC_BATCH_SIZES } from '../shared/syncConfig'
import type { KeyProvider } from '../keys/Keyring'

type AnyMock = Mock<(...args: any[]) => any>

const ITEM = 'item-1' as ItemId
/** The poll's signal, which every push needs */
const signal = new AbortController().signal

function bytes(length: number): Uint8Array {
  return new Uint8Array(length).fill(1)
}

describe('ChangeOutbox', () => {
  let db: SyncLogDatabase
  let session: SyncSessionState
  let itemSyncState: ItemSyncState
  let docStore: { [K in keyof ChangeOutboxDeps['docStore']]: AnyMock }
  let exchange: Mock<LogExchange>
  let encryptBytes: AnyMock
  let markSnapshotOnly: AnyMock
  let onMarked: AnyMock
  let onAcknowledged: AnyMock
  let now: number
  let outbox: ChangeOutbox

  /** The server acknowledges every row */
  const acknowledge: LogExchange = async (push, onResults) => {
    await onResults(push.map((message, index) => ({ itemId: message.itemId, seq: index + 1 })))
  }

  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    db = new SyncLogDatabase('account-1')
    session = new SyncSessionState()
    itemSyncState = new ItemSyncState({ db, session })
    docStore = {
      readChangesSince: vi.fn().mockResolvedValue({ changes: [bytes(10)], heads: ['head-2'] }),
      hasDataInStorage: vi.fn().mockResolvedValue(true),
      flushToStorage: vi.fn().mockResolvedValue(undefined),
    }
    exchange = vi.fn(acknowledge)
    encryptBytes = vi.fn(async (data: Uint8Array) => ({ iv: 'iv', cipher: 'c'.repeat(data.byteLength), kver: '1', format: 2 }))
    // As the schedule's does, which also makes the snapshot due
    markSnapshotOnly = vi.fn((itemId: ItemId) => itemSyncState.setSnapshotOnly(itemId))
    onMarked = vi.fn()
    // As the context's does, through the snapshot schedule
    onAcknowledged = vi.fn((itemId: ItemId) => itemSyncState.markDirty(itemId))
    now = 1_000
    outbox = new ChangeOutbox({
      db,
      docStore: docStore as unknown as ChangeOutboxDeps['docStore'],
      keys: { encryptBytes } as unknown as KeyProvider,
      session,
      itemSyncState,
      exchange,
      snapshotSchedule: { markSnapshotOnly },
      onMarked,
      onAcknowledged,
      now: () => now,
    })
  })

  afterEach(async () => {
    await itemSyncState.shutdown({ clearLocalData: true })
    await db.close()
  })

  it('marks an item pending and asks for a push', async () => {
    await outbox.mark(ITEM)

    expect(await outbox.listPending()).toEqual([ITEM])
    expect(await readPendingMarks(db).isPending(ITEM)).toBe(true)
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
  })

  describe('why a push skipped an item', () => {
    async function markOf(itemId: ItemId): Promise<PendingMark | undefined> {
      return db.get<PendingMark>(SYNC_LOG_STORES.outbox, itemId)
    }

    it('records a change only a snapshot can deliver, once', async () => {
      docStore.readChangesSince.mockResolvedValue({ changes: [bytes(MAX_INCREMENTAL_MESSAGE_BYTES + 1)], heads: ['h'] })
      await outbox.mark(ITEM)
      const update = vi.spyOn(db, 'update')

      await outbox.pushPending(signal)
      await outbox.pushPending(signal)

      expect((await markOf(ITEM))?.blocked).toBe('snapshotOnly')
      const blockedWrites = update.mock.calls.filter(([, keys]) => keys.includes(ITEM))
      expect(blockedWrites).toHaveLength(1)
    })

    it('records a doc that exists but will not load', async () => {
      docStore.readChangesSince.mockResolvedValue(null)
      await outbox.mark(ITEM)

      await outbox.pushPending(signal)

      expect((await markOf(ITEM))?.blocked).toBe('unloadable')
    })
  })

  it('reports no read when there is nothing to push', async () => {
    expect(await outbox.pushPending(signal)).toBe(false)

    docStore.readChangesSince.mockResolvedValueOnce({ changes: [], heads: ['head-1'] })
    await outbox.mark(ITEM)
    expect(await outbox.pushPending(signal)).toBe(false)

    expect(exchange).not.toHaveBeenCalled()
  })

  it('pushes changes encrypted with the item ID, then records the heads and clears the mark', async () => {
    await outbox.mark(ITEM)

    expect(await outbox.pushPending(signal)).toBe(true)

    expect(encryptBytes).toHaveBeenCalledWith(expect.any(Uint8Array), ITEM)
    expect(exchange).toHaveBeenCalledTimes(1)
    expect(itemSyncState.getServerHeads(ITEM)).toEqual(['head-2'])
    expect(await outbox.listPending()).toEqual([])
  })

  it('marks an acknowledged item dirty in the same save as its server heads', async () => {
    await outbox.mark(ITEM)
    const update = vi.spyOn(db, 'update')

    await outbox.pushPending(signal)

    expect(onAcknowledged).toHaveBeenCalledWith(ITEM)
    const recordWrites = update.mock.calls.filter(([store]) => store === SYNC_LOG_STORES.items)
    expect(recordWrites).toHaveLength(1)
    expect(await db.get(SYNC_LOG_STORES.items, ITEM)).toEqual({ itemId: ITEM, serverHeads: ['head-2'], dirty: true })
  })

  it('marks nothing dirty for a false mark or a failed push', async () => {
    docStore.readChangesSince.mockResolvedValueOnce({ changes: [], heads: ['head-1'] })
    await outbox.mark(ITEM)
    await outbox.pushPending(signal)

    await outbox.mark(ITEM)
    exchange.mockRejectedValueOnce(new Error('offline'))
    await expect(outbox.pushPending(signal)).rejects.toThrow('offline')

    expect(onAcknowledged).not.toHaveBeenCalled()
  })

  describe('an acknowledgement that fails to save', () => {
    let failRecordSaves: boolean

    beforeEach(() => {
      failRecordSaves = true
      const update = db.update.bind(db)
      vi.spyOn(db, 'update').mockImplementation((async (store: string, ...rest: unknown[]) => {
        if (store === SYNC_LOG_STORES.items && failRecordSaves) throw new Error('disk full')
        return (update as (...args: unknown[]) => Promise<void>)(store, ...rest)
      }) as typeof db.update)
    })

    it('keeps the mark and the item queued, and asks for the save again', async () => {
      const requestSave = vi.spyOn(itemSyncState, 'requestSave')
      await outbox.mark(ITEM)

      await outbox.pushPending(signal)

      expect(await outbox.listPending()).toEqual([ITEM])
      expect(onAcknowledged).toHaveBeenCalledWith(ITEM)
      expect(itemSyncState.hasUnsaved(ITEM, 'serverHeads')).toBe(true)
      expect(itemSyncState.hasUnsaved(ITEM, 'dirty')).toBe(true)
      expect(requestSave).toHaveBeenCalled()
    })

    it('keeps the mark while the heads are unsaved, and clears it at the next push once they are saved', async () => {
      await outbox.mark(ITEM)
      await outbox.pushPending(signal)
      // The doc has nothing after the heads the acknowledgement recorded
      docStore.readChangesSince.mockResolvedValue({ changes: [], heads: ['head-2'] })

      await outbox.pushPending(signal)
      expect(await outbox.listPending()).toEqual([ITEM])
      expect(exchange).toHaveBeenCalledTimes(1)

      failRecordSaves = false
      await itemSyncState.save()
      await outbox.pushPending(signal)

      expect(await outbox.listPending()).toEqual([])
      expect(await db.get(SYNC_LOG_STORES.items, ITEM)).toEqual({ itemId: ITEM, serverHeads: ['head-2'], dirty: true })
    })
  })

  describe('an acknowledgement whose doc fails to store', () => {
    beforeEach(() => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      docStore.flushToStorage.mockRejectedValue(new DOMException('The disk is full', 'QuotaExceededError'))
    })

    it('stores the doc before saving the acknowledgement', async () => {
      docStore.flushToStorage.mockResolvedValue(undefined)
      const save = vi.spyOn(itemSyncState, 'save')
      await outbox.mark(ITEM)

      await outbox.pushPending(signal)

      expect(docStore.flushToStorage).toHaveBeenCalledWith([ITEM])
      expect(docStore.flushToStorage.mock.invocationCallOrder[0]).toBeLessThan(save.mock.invocationCallOrder[0])
      expect(await outbox.listPending()).toEqual([])
    })

    it('keeps the mark and the item queued, saving nothing first', async () => {
      const save = vi.spyOn(itemSyncState, 'save')
      await outbox.mark(ITEM)

      await outbox.pushPending(signal)

      expect(await outbox.listPending()).toEqual([ITEM])
      expect(onAcknowledged).toHaveBeenCalledWith(ITEM)
      expect(save).not.toHaveBeenCalled()
      expect(itemSyncState.hasUnsaved(ITEM, 'serverHeads')).toBe(true)
    })

    it('keeps the mark once the heads are saved, until the doc is stored', async () => {
      await outbox.mark(ITEM)
      await outbox.pushPending(signal)
      await itemSyncState.save()
      // The doc has nothing after the heads the acknowledgement recorded
      docStore.readChangesSince.mockResolvedValue({ changes: [], heads: ['head-2'] })

      await outbox.pushPending(signal)
      expect(await outbox.listPending()).toEqual([ITEM])
      expect(exchange).toHaveBeenCalledTimes(1)

      docStore.flushToStorage.mockResolvedValue(undefined)
      await outbox.pushPending(signal)
      expect(await outbox.listPending()).toEqual([])
    })
  })

  it('reads changes after the server heads', async () => {
    itemSyncState.setServerHeads(ITEM, ['head-1'])
    await outbox.mark(ITEM)

    await outbox.pushPending(signal)

    expect(docStore.readChangesSince).toHaveBeenCalledWith(ITEM, ['head-1'])
  })

  it('clears a false mark without a request', async () => {
    docStore.readChangesSince.mockResolvedValue({ changes: [], heads: ['head-1'] })
    await outbox.mark(ITEM)

    await outbox.pushPending(signal)

    expect(exchange).not.toHaveBeenCalled()
    expect(await outbox.listPending()).toEqual([])
  })

  it('keeps the mark of an edit made while a push was in flight', async () => {
    await outbox.mark(ITEM)
    exchange.mockImplementationOnce(async (push, onResults) => {
      await outbox.mark(ITEM)
      await acknowledge(push, onResults, signal)
    })

    await outbox.pushPending(signal)

    expect(await outbox.listPending()).toEqual([ITEM])
  })

  it('changes nothing locally when a push fails', async () => {
    await outbox.mark(ITEM)
    exchange.mockRejectedValueOnce(new Error('offline'))

    await expect(outbox.pushPending(signal)).rejects.toThrow('offline')

    expect(itemSyncState.hasServerHeads(ITEM)).toBe(false)
    expect(await outbox.listPending()).toEqual([ITEM])
  })

  it('groups changes in order into rows under the limit', async () => {
    const half = MAX_INCREMENTAL_MESSAGE_BYTES / 2
    docStore.readChangesSince.mockResolvedValue({
      changes: [bytes(half), bytes(half), bytes(half)],
      heads: ['head-2'],
    })
    await outbox.mark(ITEM)

    await outbox.pushPending(signal)

    expect(exchange.mock.calls[0][0]).toHaveLength(2)
    expect(encryptBytes.mock.calls.map(([row]) => row.byteLength)).toEqual([half * 2, half])
  })

  it('records nothing until every row of a split set is acknowledged, and a retry resends it all', async () => {
    const rowCount = Math.ceil(SYNC_BATCH_SIZES.logPushChars / MAX_INCREMENTAL_MESSAGE_BYTES) + 2
    const changes = Array.from({ length: rowCount }, () => bytes(MAX_INCREMENTAL_MESSAGE_BYTES))
    docStore.readChangesSince.mockResolvedValue({ changes, heads: ['head-2'] })
    await outbox.mark(ITEM)
    exchange.mockImplementationOnce(acknowledge).mockRejectedValueOnce(new Error('offline'))

    await expect(outbox.pushPending(signal)).rejects.toThrow('offline')

    expect(itemSyncState.hasServerHeads(ITEM)).toBe(false)
    expect(await outbox.listPending()).toEqual([ITEM])

    await outbox.pushPending(signal)

    expect(itemSyncState.getServerHeads(ITEM)).toEqual(['head-2'])
    expect(await outbox.listPending()).toEqual([])
    const sent = exchange.mock.calls.slice(2).flatMap(([push]) => push)
    expect(sent).toHaveLength(rowCount)
  })

  it('throws when the server leaves rows unacknowledged', async () => {
    await outbox.mark(ITEM)
    exchange.mockImplementationOnce(async (_push, onResults) => onResults([]))

    await expect(outbox.pushPending(signal)).rejects.toThrow("didn't acknowledge")

    expect(await outbox.listPending()).toEqual([ITEM])
  })

  it('sends a single oversized change by snapshot instead, keeping the mark', async () => {
    docStore.readChangesSince.mockResolvedValue({ changes: [bytes(MAX_INCREMENTAL_MESSAGE_BYTES + 1)], heads: ['head-2'] })
    await outbox.mark(ITEM)

    await outbox.pushPending(signal)

    expect(exchange).not.toHaveBeenCalled()
    expect(markSnapshotOnly).toHaveBeenCalledWith(ITEM)
    expect(itemSyncState.isSnapshotOnly(ITEM)).toBe(true)
    expect(await outbox.listPending()).toEqual([ITEM])

    itemSyncState.confirmSnapshotOnly(ITEM, ['head-2'])

    expect(itemSyncState.isSnapshotOnly(ITEM)).toBe(false)
    expect(itemSyncState.getServerHeads(ITEM)).toEqual(['head-2'])
  })

  it('still sends a snapshot-only item by snapshot after a reload', async () => {
    docStore.readChangesSince.mockResolvedValue({ changes: [bytes(MAX_INCREMENTAL_MESSAGE_BYTES + 1)], heads: ['head-2'] })
    await outbox.mark(ITEM)
    await outbox.pushPending(signal)
    await itemSyncState.shutdown()

    itemSyncState = new ItemSyncState({ db, session })
    await itemSyncState.load()
    const reloaded = new ChangeOutbox({
      db,
      docStore: docStore as unknown as ChangeOutboxDeps['docStore'],
      keys: { encryptBytes } as unknown as KeyProvider,
      session,
      itemSyncState,
      exchange,
      snapshotSchedule: { markSnapshotOnly },
      onMarked,
      onAcknowledged,
    })
    docStore.readChangesSince.mockClear()
    await reloaded.pushPending(signal)

    expect(itemSyncState.isSnapshotOnly(ITEM)).toBe(true)
    expect(docStore.readChangesSince).not.toHaveBeenCalled()
    expect(exchange).not.toHaveBeenCalled()
  })

  describe('filling requests', () => {
    const items = (count: number): ItemId[] => Array.from({ length: count }, (_, index) => `item-${index}` as ItemId)

    it('sends many small items in one request', async () => {
      const itemIds = items(40)
      await outbox.markAll(itemIds)

      await outbox.pushPending(signal)

      expect(exchange).toHaveBeenCalledTimes(1)
      expect(exchange.mock.calls[0][0]).toHaveLength(40)
      expect(await outbox.listPending()).toEqual([])
    })

    it('starts a new request at the row limit, never splitting an item across two', async () => {
      docStore.readChangesSince.mockResolvedValue({
        changes: [bytes(MAX_INCREMENTAL_MESSAGE_BYTES), bytes(MAX_INCREMENTAL_MESSAGE_BYTES)],
        heads: ['head-2'],
      })
      const itemIds = items(60)

      await outbox.pushItems(itemIds, signal)

      const sizes = exchange.mock.calls.map(([push]) => push.length)
      expect(sizes.every(size => size <= SYNC_BATCH_SIZES.logPushRows && size % 2 === 0)).toBe(true)
      expect(sizes.reduce((total, size) => total + size, 0)).toBe(120)
      expect(itemIds.every(itemId => itemSyncState.getServerHeads(itemId)?.[0] === 'head-2')).toBe(true)
    })

    it('starts a new request before the ciphertext limit', async () => {
      const rowsPerItem = 3
      docStore.readChangesSince.mockResolvedValue({
        changes: Array.from({ length: rowsPerItem }, () => bytes(MAX_INCREMENTAL_MESSAGE_BYTES)),
        heads: ['head-2'],
      })
      const itemIds = items(Math.ceil(SYNC_BATCH_SIZES.logPushChars / (MAX_INCREMENTAL_MESSAGE_BYTES * rowsPerItem)) + 1)

      await outbox.pushItems(itemIds, signal)

      expect(exchange.mock.calls.length).toBeGreaterThan(1)
      for (const [push] of exchange.mock.calls) {
        const chars = push.reduce((total, message) => total + message.encryptedMessage.cipher.length, 0)
        expect(chars).toBeLessThanOrEqual(SYNC_BATCH_SIZES.logPushChars)
      }
    })

    it('stops between requests when aborted', async () => {
      docStore.readChangesSince.mockResolvedValue({
        changes: [bytes(MAX_INCREMENTAL_MESSAGE_BYTES), bytes(MAX_INCREMENTAL_MESSAGE_BYTES)],
        heads: ['head-2'],
      })
      const controller = new AbortController()
      exchange.mockImplementation(async (push, onResults) => {
        await acknowledge(push, onResults, signal)
        controller.abort()
      })

      await expect(outbox.pushItems(items(8), controller.signal)).rejects.toThrow()

      expect(exchange).toHaveBeenCalledTimes(1)
      expect(exchange.mock.calls[0][0].length).toBeLessThan(16)
    })
  })

  describe('a request the server refuses', () => {
    const OTHER = 'item-2' as ItemId
    const refused = Object.assign(new Error('Invalid input'), { data: { code: 'BAD_REQUEST', httpStatus: 400 } })

    /** The server refuses any request carrying ITEM's rows, and acknowledges the rest */
    const refuseItem: LogExchange = async (push, onResults) => {
      if (push.some(message => message.itemId === ITEM)) throw refused
      await acknowledge(push, onResults, signal)
    }

    it('delivers the item it refuses on its own by snapshot, and pushes the others', async () => {
      exchange.mockImplementation(refuseItem)
      await outbox.mark(ITEM)
      await outbox.mark(OTHER)

      // OTHER's request read the log
      expect(await outbox.pushPending(signal)).toBe(true)

      expect(itemSyncState.isSnapshotOnly(ITEM)).toBe(true)
      expect(markSnapshotOnly).toHaveBeenCalledWith(ITEM)
      expect(itemSyncState.getServerHeads(OTHER)).toEqual(['head-2'])
      // The snapshot carries ITEM's changes, so its mark stays until that's confirmed
      expect(await outbox.listPending()).toEqual([ITEM])

      exchange.mockClear()
      await outbox.pushPending(signal)
      expect(exchange).not.toHaveBeenCalled()
    })

    // The poll reads the log itself
    it('reports no read when the server refused every request', async () => {
      exchange.mockImplementation(refuseItem)
      await outbox.mark(ITEM)

      expect(await outbox.pushPending(signal)).toBe(false)
      expect(exchange).toHaveBeenCalledTimes(1)
    })

    it('finds the refused item among a full request by halving it', async () => {
      exchange.mockImplementation(refuseItem)
      const others = Array.from({ length: 31 }, (_, index) => `other-${index}` as ItemId)
      await outbox.markAll([...others, ITEM])

      await outbox.pushPending(signal)

      expect(itemSyncState.isSnapshotOnly(ITEM)).toBe(true)
      expect(others.every(itemId => itemSyncState.getServerHeads(itemId)?.[0] === 'head-2')).toBe(true)
      expect(await outbox.listPending()).toEqual([ITEM])
      // 32 items take a refused request per halving down to ITEM, and one accepted request per other half
      expect(exchange.mock.calls.length).toBeLessThanOrEqual(1 + 2 * Math.log2(32))
    })

    it('still fails the push on an outage, which a later poll retries', async () => {
      exchange.mockRejectedValue(Object.assign(new Error('Service unavailable'), { data: { httpStatus: 503 } }))
      await outbox.mark(ITEM)

      await expect(outbox.pushPending(signal)).rejects.toThrow('Service unavailable')

      expect(itemSyncState.isSnapshotOnly(ITEM)).toBe(false)
      expect(markSnapshotOnly).not.toHaveBeenCalled()
    })

    // The account is over its log quota: nothing is wrong with the item, so it mustn't go snapshot-only
    it('still fails the push when the account is over a quota, which a later poll retries', async () => {
      exchange.mockRejectedValue(Object.assign(new Error('QUOTA_EXCEEDED'), {
        data: { code: 'TOO_MANY_REQUESTS', httpStatus: 429 },
      }))
      await outbox.mark(ITEM)

      await expect(outbox.pushPending(signal)).rejects.toThrow('QUOTA_EXCEEDED')

      expect(itemSyncState.isSnapshotOnly(ITEM)).toBe(false)
      expect(markSnapshotOnly).not.toHaveBeenCalled()
      expect(await outbox.listPending()).toEqual([ITEM])
    })

    it('still fails the push when the server refuses the session', async () => {
      exchange.mockRejectedValue(Object.assign(new Error('UNAUTHORIZED'), { data: { code: 'UNAUTHORIZED', httpStatus: 401 } }))
      await outbox.mark(ITEM)

      await expect(outbox.pushPending(signal)).rejects.toThrow('UNAUTHORIZED')
      expect(itemSyncState.isSnapshotOnly(ITEM)).toBe(false)
    })
  })

  it('keeps the mark of a doc that exists but will not load, and clears one with no doc', async () => {
    docStore.readChangesSince.mockResolvedValue(null)
    await outbox.mark(ITEM)

    await outbox.pushPending(signal)
    expect(await outbox.listPending()).toEqual([ITEM])

    docStore.hasDataInStorage.mockResolvedValue(false)
    await outbox.pushPending(signal)
    expect(await outbox.listPending()).toEqual([])
  })

  it('pushes the given items whether or not they are marked', async () => {
    await outbox.pushItems([ITEM], signal)

    expect(exchange).toHaveBeenCalledTimes(1)
    expect(itemSyncState.getServerHeads(ITEM)).toEqual(['head-2'])
  })
})
