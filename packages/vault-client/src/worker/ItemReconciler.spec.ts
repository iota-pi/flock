import type { Mock } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import type { ItemId, SyncLogEntry } from '@vault/shared'
import type { KeyProvider } from '../keys/Keyring'
import { ItemReconciler, MAX_PULL_RETRIES, type ItemReconcilerDeps, type ParkedEntry } from './ItemReconciler'
import { SyncLogDatabase } from './stores/SyncLogDatabase'
import { SYNC_LOG_STORES } from '../shared/syncLogStorage'
import { GAP_HEAL_DELAYS, SYNC_TIMEOUTS } from '../shared/syncConfig'

type AnyMock = Mock<(...args: any[]) => any>

const ITEM = 'item-1' as ItemId

function entry(seq: number, kver = '1'): SyncLogEntry {
  return { seq, itemId: ITEM, encryptedMessage: { iv: 'iv', cipher: `row-${seq}`, kver }, createdAt: 0 }
}

describe('ItemReconciler', () => {
  let db: SyncLogDatabase
  let keys: { hasKey: AnyMock; decryptBytes: AnyMock }
  let docStore: { getMissingDeps: AnyMock; flushToStorage: AnyMock }
  let indexManager: { listTombstoneIds: AnyMock }
  let incoming: { apply: AnyMock }
  let recoveryManager: {
    quarantine: AnyMock
    reportDecryptionFailure: AnyMock
    resolveQuarantines: AnyMock
    listRecoveryItems: AnyMock
  }
  let fetchSnapshots: AnyMock
  let onWorkDue: AnyMock
  let onHealingChange: AnyMock
  let reconciler: ItemReconciler

  function createReconciler(): ItemReconciler {
    return new ItemReconciler({
      db,
      keys: keys as unknown as KeyProvider,
      docStore: docStore as unknown as ItemReconcilerDeps['docStore'],
      indexManager: indexManager as unknown as ItemReconcilerDeps['indexManager'],
      incoming: incoming as unknown as ItemReconcilerDeps['incoming'],
      recoveryManager: recoveryManager as unknown as ItemReconcilerDeps['recoveryManager'],
      fetchSnapshots,
      onWorkDue,
      onHealingChange,
    })
  }

  const parked = () => db.getAll<ParkedEntry>(SYNC_LOG_STORES.parked)

  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    db = new SyncLogDatabase('account-1')
    keys = {
      hasKey: vi.fn().mockReturnValue(true),
      decryptBytes: vi.fn(async () => new Uint8Array([1])),
    }
    docStore = {
      getMissingDeps: vi.fn().mockResolvedValue([]),
      flushToStorage: vi.fn().mockResolvedValue(undefined),
    }
    indexManager = { listTombstoneIds: vi.fn().mockResolvedValue([]) }
    incoming = { apply: vi.fn().mockResolvedValue(true) }
    recoveryManager = {
      quarantine: vi.fn().mockResolvedValue(undefined),
      reportDecryptionFailure: vi.fn().mockResolvedValue(undefined),
      resolveQuarantines: vi.fn().mockResolvedValue(undefined),
      listRecoveryItems: vi.fn().mockResolvedValue([]),
    }
    fetchSnapshots = vi.fn(async (itemIds: ItemId[]) => itemIds)
    onWorkDue = vi.fn()
    onHealingChange = vi.fn()
    reconciler = createReconciler()
  })

  afterEach(async () => {
    await db.close()
  })

  it('keeps the row\'s ciphertext as it arrived', async () => {
    await reconciler.park(entry(1), 'missingDeps')

    expect(await parked()).toEqual([expect.objectContaining({
      seq: 1,
      itemId: ITEM,
      encryptedMessage: entry(1).encryptedMessage,
      reason: 'missingDeps',
    })])
  })

  it('fetches the snapshot at once, applies parked rows in order, and clears them', async () => {
    await reconciler.park(entry(2), 'missingDeps')
    await reconciler.park(entry(1), 'missingDeps')

    await reconciler.runDue()

    expect(fetchSnapshots).toHaveBeenCalledWith([ITEM], undefined)
    expect(keys.decryptBytes.mock.calls.map(([payload]) => payload.cipher)).toEqual(['row-1', 'row-2'])
    expect(await parked()).toEqual([])
    expect(recoveryManager.resolveQuarantines).toHaveBeenCalledWith([ITEM], new Set(['missingChanges']))
    expect(onHealingChange).toHaveBeenLastCalledWith(false)
  })

  it('stores the healed docs before deleting their rows', async () => {
    const other = 'item-2' as ItemId
    await reconciler.park(entry(1), 'missingDeps')
    await reconciler.park({ ...entry(2), itemId: other }, 'missingDeps')
    const remove = vi.spyOn(db, 'delete')

    await reconciler.runDue()

    expect(docStore.flushToStorage).toHaveBeenCalledTimes(1)
    expect(docStore.flushToStorage).toHaveBeenCalledWith([ITEM, other])
    expect(docStore.flushToStorage.mock.invocationCallOrder[0]).toBeLessThan(remove.mock.invocationCallOrder[0])
    expect(await parked()).toEqual([])
  })

  it('keeps the rows when their docs fail to store, and deletes them once a later run stores them', async () => {
    docStore.flushToStorage.mockRejectedValueOnce(new DOMException('The disk is full', 'QuotaExceededError'))
    await reconciler.park(entry(1), 'missingDeps')

    await expect(reconciler.runDue()).rejects.toThrow('The disk is full')
    expect(await parked()).toHaveLength(1)
    expect(recoveryManager.resolveQuarantines).not.toHaveBeenCalled()

    await reconciler.runDue()
    expect(incoming.apply).toHaveBeenCalledTimes(2)
    expect(await parked()).toEqual([])
    expect(recoveryManager.resolveQuarantines).toHaveBeenCalledWith([ITEM], new Set(['missingChanges']))
  })

  it('stores nothing while dependencies are missing', async () => {
    incoming.apply.mockResolvedValue(false)
    await reconciler.park(entry(1), 'missingDeps')

    await reconciler.runDue()

    expect(docStore.flushToStorage).not.toHaveBeenCalled()
    expect(await parked()).toHaveLength(1)
  })

  it('reads the parked rows twice per run, however many items are due', async () => {
    const items = ['item-a', 'item-b', 'item-c'] as ItemId[]
    for (const [index, itemId] of items.entries()) {
      await reconciler.park({ ...entry(index + 1), itemId }, 'missingDeps')
    }
    const getAll = vi.spyOn(db, 'getAll')

    await reconciler.runDue()

    expect(getAll).toHaveBeenCalledTimes(2)
    expect(await parked()).toEqual([])
    expect(recoveryManager.resolveQuarantines).toHaveBeenCalledTimes(items.length)
  })

  it('keeps an item that a pull parks another row for during the run', async () => {
    await reconciler.park(entry(1), 'missingDeps')
    incoming.apply.mockImplementationOnce(async () => {
      await reconciler.park(entry(2), 'missingDeps')
      return true
    })

    await reconciler.runDue()

    expect((await parked()).map(row => row.seq)).toEqual([2])
    expect(recoveryManager.resolveQuarantines).not.toHaveBeenCalled()
    expect(onHealingChange).toHaveBeenLastCalledWith(true)
  })

  it('does not fetch a snapshot for a missing key', async () => {
    keys.hasKey.mockReturnValue(false)
    await reconciler.park(entry(1, '2'), 'missingKey')

    await reconciler.runDue()

    expect(fetchSnapshots).not.toHaveBeenCalled()
    expect(await parked()).toHaveLength(1)
    expect(recoveryManager.quarantine).not.toHaveBeenCalled()
    expect(recoveryManager.reportDecryptionFailure).not.toHaveBeenCalled()
  })

  it('applies a missing-key row after a keyring update', async () => {
    keys.hasKey.mockReturnValue(false)
    await reconciler.park(entry(1, '2'), 'missingKey')
    await reconciler.runDue()

    keys.hasKey.mockReturnValue(true)
    reconciler.onKeyringUpdated()
    await reconciler.runDue()

    expect(onWorkDue).toHaveBeenCalled()
    expect(incoming.apply).toHaveBeenCalledTimes(1)
    expect(await parked()).toEqual([])
  })

  it('keeps rows while dependencies are missing, and retries on backoff', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      incoming.apply.mockResolvedValue(false)
      await reconciler.park(entry(1), 'missingDeps')

      await reconciler.runDue()
      expect(await parked()).toHaveLength(1)

      await reconciler.runDue()
      expect(incoming.apply).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(GAP_HEAL_DELAYS[0])
      await reconciler.runDue()
      expect(incoming.apply).toHaveBeenCalledTimes(2)

      await reconciler.runDue()
      expect(incoming.apply).toHaveBeenCalledTimes(2)
      vi.advanceTimersByTime(GAP_HEAL_DELAYS[1])
      await reconciler.runDue()
      expect(incoming.apply).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries at once after a later entry for the item, and after a manifest sync', async () => {
    incoming.apply.mockResolvedValue(false)
    await reconciler.park(entry(1), 'missingDeps')
    await reconciler.runDue()

    reconciler.onLogEntry(ITEM)
    await reconciler.runDue()
    expect(incoming.apply).toHaveBeenCalledTimes(2)

    reconciler.onManifestSynced()
    await reconciler.runDue()
    expect(incoming.apply).toHaveBeenCalledTimes(3)
  })

  it('re-applies rows without fetching the snapshot again after later rows and a manifest sync', async () => {
    incoming.apply.mockResolvedValue(false)
    await reconciler.park(entry(1), 'missingDeps')
    await reconciler.runDue()
    expect(fetchSnapshots).toHaveBeenCalledTimes(1)

    await reconciler.park(entry(2), 'missingDeps')
    reconciler.onLogEntry(ITEM)
    await reconciler.runDue()
    reconciler.onManifestSynced()
    await reconciler.runDue()

    expect(fetchSnapshots).toHaveBeenCalledTimes(1)
    expect(incoming.apply).toHaveBeenCalledTimes(5)
  })

  it('fetches the snapshot again on its own backoff while later rows keep arriving', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      incoming.apply.mockResolvedValue(false)
      await reconciler.park(entry(1), 'missingDeps')
      await reconciler.runDue()

      // Rows every 15 s would each push the re-apply backoff on, but not the snapshot's
      for (let elapsed = 0; elapsed < GAP_HEAL_DELAYS[0]; elapsed += 15_000) {
        vi.advanceTimersByTime(15_000)
        reconciler.onLogEntry(ITEM)
        await reconciler.runDue()
      }
      expect(fetchSnapshots).toHaveBeenCalledTimes(2)

      vi.advanceTimersByTime(GAP_HEAL_DELAYS[1] - 1)
      reconciler.onLogEntry(ITEM)
      await reconciler.runDue()
      expect(fetchSnapshots).toHaveBeenCalledTimes(2)
      vi.advanceTimersByTime(1)
      await reconciler.runDue()
      expect(fetchSnapshots).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fetches the snapshot again after a keyring update', async () => {
    incoming.apply.mockResolvedValue(false)
    await reconciler.park(entry(1), 'missingDeps')
    await reconciler.runDue()

    reconciler.onKeyringUpdated()
    await reconciler.runDue()

    expect(fetchSnapshots).toHaveBeenCalledTimes(2)
  })

  it('keeps a row the doc applied while the doc still reports missing dependencies', async () => {
    docStore.getMissingDeps.mockResolvedValue(['missing-hash'])
    await reconciler.park(entry(1), 'missingDeps')

    await reconciler.runDue()

    expect(await parked()).toHaveLength(1)
  })

  it('tells the user after a day, keeps trying, and clears it on a heal', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      incoming.apply.mockResolvedValue(false)
      await reconciler.park(entry(1), 'missingDeps')
      await reconciler.runDue()
      expect(recoveryManager.quarantine).not.toHaveBeenCalled()

      vi.advanceTimersByTime(SYNC_TIMEOUTS.missingChangesQuarantine)
      await reconciler.runDue()
      expect(recoveryManager.quarantine).toHaveBeenCalledWith(
        ITEM,
        'missingChanges',
        { code: 'waitingForChanges' },
      )

      incoming.apply.mockResolvedValue(true)
      reconciler.onManifestSynced()
      await reconciler.runDue()
      expect(recoveryManager.resolveQuarantines).toHaveBeenCalledWith([ITEM], new Set(['missingChanges']))
      expect(await parked()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('tells the user after a day of a row that won\'t apply, keeps the row, and clears it on a heal', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      incoming.apply.mockRejectedValue(new Error('Refusing to overwrite'))
      await reconciler.park(entry(1), 'apply')
      await reconciler.runDue()
      expect(recoveryManager.quarantine).not.toHaveBeenCalled()
      expect(await parked()).toHaveLength(1)

      vi.advanceTimersByTime(SYNC_TIMEOUTS.missingChangesQuarantine)
      await reconciler.runDue()
      expect(recoveryManager.quarantine).toHaveBeenCalledWith(
        ITEM,
        'missingChanges',
        { code: 'changesWontApply' },
      )
      expect(await parked()).toHaveLength(1)

      incoming.apply.mockResolvedValue(true)
      reconciler.onManifestSynced()
      await reconciler.runDue()
      expect(recoveryManager.resolveQuarantines).toHaveBeenCalledWith([ITEM], new Set(['missingChanges']))
      expect(await parked()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a deleted item\'s rows and never quarantines it, though its dependencies never come', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      incoming.apply.mockResolvedValue(false)
      await reconciler.park(entry(1), 'missingDeps')
      await reconciler.runDue()
      expect(await parked()).toHaveLength(1)

      indexManager.listTombstoneIds.mockResolvedValue([ITEM])
      vi.advanceTimersByTime(SYNC_TIMEOUTS.missingChangesQuarantine)
      reconciler.onManifestSynced()
      await reconciler.runDue()

      expect(recoveryManager.quarantine).not.toHaveBeenCalled()
      expect(recoveryManager.resolveQuarantines).toHaveBeenCalledWith([ITEM], new Set(['missingChanges']))
      expect(await parked()).toEqual([])
      expect(onHealingChange).toHaveBeenLastCalledWith(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('quarantines a row that never decrypts after the retry limit, and drops it', async () => {
    keys.decryptBytes.mockRejectedValue(new Error('bad tag'))
    await reconciler.park(entry(1), 'decryption')

    for (let attempt = 1; attempt < MAX_PULL_RETRIES; attempt += 1) {
      expect(recoveryManager.reportDecryptionFailure).not.toHaveBeenCalled()
      reconciler.onManifestSynced()
      await reconciler.runDue()
    }

    expect(recoveryManager.reportDecryptionFailure).toHaveBeenCalledWith(ITEM, 'pullDecryption', expect.any(Error))
    expect(await parked()).toEqual([])
  })

  it('picks up parked entries after a reload', async () => {
    await reconciler.park(entry(1), 'missingDeps')

    const reloaded = createReconciler()
    await reloaded.load()
    await reloaded.runDue()

    expect(fetchSnapshots).toHaveBeenCalledWith([ITEM], undefined)
    expect(await parked()).toEqual([])
  })

  it('fetches a snapshot on request for an indexed item with no local data', async () => {
    reconciler.reconcile(ITEM, { fetch: true })

    expect(onWorkDue).toHaveBeenCalled()
    await reconciler.runDue()

    expect(fetchSnapshots).toHaveBeenCalledWith([ITEM], undefined)
    fetchSnapshots.mockClear()
    await reconciler.runDue()
    expect(fetchSnapshots).not.toHaveBeenCalled()
  })

  it('lets a failed fetch fail the poll, leaving the item for the next one', async () => {
    fetchSnapshots.mockRejectedValueOnce(new Error('offline'))
    await reconciler.park(entry(1), 'missingDeps')

    await expect(reconciler.runDue()).rejects.toThrow('offline')

    await reconciler.runDue()
    expect(await parked()).toEqual([])
  })

  it('applies parked rows on request without fetching', async () => {
    await reconciler.park(entry(1), 'missingKey')

    reconciler.reconcile(ITEM, { fetch: false })
    await reconciler.runDue()

    expect(fetchSnapshots).not.toHaveBeenCalled()
    expect(await parked()).toEqual([])
  })

  describe('tickets', () => {
    it('settles a ticket with whether its own item merged, though another item in the fetch failed', async () => {
      const other = 'item-2' as ItemId
      fetchSnapshots.mockResolvedValueOnce([ITEM])
      reconciler.reconcile(other, { fetch: true })
      const ticket = reconciler.openTicket(ITEM)
      const otherTicket = reconciler.openTicket(other)

      await reconciler.runDue()

      expect(fetchSnapshots).toHaveBeenCalledWith([other, ITEM], undefined)
      expect(reconciler.closeTicket(ticket)).toBe(true)
      expect(reconciler.closeTicket(otherTicket)).toBe(false)
    })

    it('fetches at once, past the snapshot backoff', async () => {
      await reconciler.park(entry(1), 'missingDeps')
      incoming.apply.mockResolvedValue(false)
      await reconciler.runDue()
      fetchSnapshots.mockClear()

      const ticket = reconciler.openTicket(ITEM)
      await reconciler.runDue()

      expect(fetchSnapshots).toHaveBeenCalledWith([ITEM], undefined)
      expect(reconciler.closeTicket(ticket)).toBe(true)
    })

    it('leaves a ticket unsettled when the fetch fails as a whole, and serves it at the next run', async () => {
      fetchSnapshots.mockRejectedValueOnce(new Error('offline'))
      const ticket = reconciler.openTicket(ITEM)

      await expect(reconciler.runDue()).rejects.toThrow('offline')
      expect(ticket.settled).toBeUndefined()

      await reconciler.runDue()
      expect(reconciler.closeTicket(ticket)).toBe(true)
    })

    it('reports a ticket closed before any run as not settled', () => {
      expect(reconciler.closeTicket(reconciler.openTicket(ITEM))).toBe(false)
    })
  })

  describe('quarantined server copies', () => {
    const quarantined = [
      { itemId: 'item-snapshot', kind: 'snapshotDecryption', detail: { code: 'decryptionFailed' } },
      { itemId: 'item-hydration', kind: 'unknown', detail: { code: 'hydrationFailed' } },
      { itemId: 'item-local', kind: 'localDecryption', detail: { code: 'decryptionFailed' } },
      { itemId: 'item-oversized', kind: 'oversized', detail: { code: 'oversized', sizeKb: 400 } },
    ]

    it('fetches the items quarantined for their server copy after a keyring update', async () => {
      recoveryManager.listRecoveryItems.mockResolvedValue(quarantined)

      reconciler.onKeyringUpdated()
      expect(onWorkDue).toHaveBeenCalled()
      await reconciler.runDue()

      expect(fetchSnapshots).toHaveBeenCalledWith(['item-snapshot', 'item-hydration'], undefined)
      expect(onHealingChange).toHaveBeenLastCalledWith(false)

      fetchSnapshots.mockClear()
      await reconciler.runDue()
      expect(recoveryManager.listRecoveryItems).toHaveBeenCalledTimes(1)
      expect(fetchSnapshots).not.toHaveBeenCalled()
    })

    it('reads the quarantines again at the next run when reading them fails', async () => {
      recoveryManager.listRecoveryItems.mockRejectedValueOnce(new Error('IndexedDB read failed'))
      reconciler.onKeyringUpdated()

      await expect(reconciler.runDue()).rejects.toThrow('IndexedDB read failed')

      recoveryManager.listRecoveryItems.mockResolvedValue(quarantined)
      await reconciler.runDue()
      expect(fetchSnapshots).toHaveBeenCalledWith(['item-snapshot', 'item-hydration'], undefined)
    })

    it('reads no quarantines without a keyring update', async () => {
      await reconciler.runDue()

      expect(recoveryManager.listRecoveryItems).not.toHaveBeenCalled()
    })
  })
})
