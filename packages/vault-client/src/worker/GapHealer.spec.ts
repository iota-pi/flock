import type { Mock } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import type { ItemId, SyncLogEntry } from '@vault/shared'
import type { KeyProvider } from '../keys/Keyring'
import { GapHealer, MAX_PULL_RETRIES, type GapHealerDeps, type ParkedEntry } from './GapHealer'
import { SyncLogDatabase } from './stores/SyncLogDatabase'
import { SYNC_LOG_STORES } from '../shared/syncLogStorage'
import { GAP_HEAL_DELAYS, SYNC_TIMEOUTS } from '../shared/syncConfig'

type AnyMock = Mock<(...args: any[]) => any>

const ITEM = 'item-1' as ItemId

function entry(seq: number, kver = '1'): SyncLogEntry {
  return { seq, itemId: ITEM, encryptedMessage: { iv: 'iv', cipher: `row-${seq}`, kver }, createdAt: 0 }
}

describe('GapHealer', () => {
  let db: SyncLogDatabase
  let keys: { hasKey: AnyMock; decryptBytes: AnyMock }
  let docStore: { getMissingDeps: AnyMock }
  let incoming: { apply: AnyMock }
  let recoveryManager: {
    quarantine: AnyMock
    reportDecryptionFailure: AnyMock
    resolveQuarantines: AnyMock
  }
  let fetchSnapshots: AnyMock
  let onWorkDue: AnyMock
  let onHealingChange: AnyMock
  let healer: GapHealer

  function createHealer(): GapHealer {
    return new GapHealer({
      db,
      keys: keys as unknown as KeyProvider,
      docStore: docStore as unknown as GapHealerDeps['docStore'],
      incoming: incoming as unknown as GapHealerDeps['incoming'],
      recoveryManager: recoveryManager as unknown as GapHealerDeps['recoveryManager'],
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
    docStore = { getMissingDeps: vi.fn().mockResolvedValue([]) }
    incoming = { apply: vi.fn().mockResolvedValue(true) }
    recoveryManager = {
      quarantine: vi.fn().mockResolvedValue(undefined),
      reportDecryptionFailure: vi.fn().mockResolvedValue(undefined),
      resolveQuarantines: vi.fn().mockResolvedValue(undefined),
    }
    fetchSnapshots = vi.fn().mockResolvedValue(undefined)
    onWorkDue = vi.fn()
    onHealingChange = vi.fn()
    healer = createHealer()
  })

  afterEach(async () => {
    await db.close()
  })

  it('keeps the row\'s ciphertext as it arrived', async () => {
    await healer.park(entry(1), 'missingDeps')

    expect(await parked()).toEqual([expect.objectContaining({
      seq: 1,
      itemId: ITEM,
      encryptedMessage: entry(1).encryptedMessage,
      reason: 'missingDeps',
    })])
  })

  it('fetches the snapshot at once, applies parked rows in order, and clears them', async () => {
    await healer.park(entry(2), 'missingDeps')
    await healer.park(entry(1), 'missingDeps')

    await healer.runDue()

    expect(fetchSnapshots).toHaveBeenCalledWith([ITEM], undefined)
    expect(keys.decryptBytes.mock.calls.map(([payload]) => payload.cipher)).toEqual(['row-1', 'row-2'])
    expect(await parked()).toEqual([])
    expect(recoveryManager.resolveQuarantines).toHaveBeenCalledWith([ITEM], new Set(['missingChanges']))
    expect(onHealingChange).toHaveBeenLastCalledWith(false)
  })

  it('does not fetch a snapshot for a missing key', async () => {
    keys.hasKey.mockReturnValue(false)
    await healer.park(entry(1, '2'), 'missingKey')

    await healer.runDue()

    expect(fetchSnapshots).not.toHaveBeenCalled()
    expect(await parked()).toHaveLength(1)
    expect(recoveryManager.quarantine).not.toHaveBeenCalled()
    expect(recoveryManager.reportDecryptionFailure).not.toHaveBeenCalled()
  })

  it('applies a missing-key row after a keyring update', async () => {
    keys.hasKey.mockReturnValue(false)
    await healer.park(entry(1, '2'), 'missingKey')
    await healer.runDue()

    keys.hasKey.mockReturnValue(true)
    healer.onKeyringUpdated()
    await healer.runDue()

    expect(onWorkDue).toHaveBeenCalled()
    expect(incoming.apply).toHaveBeenCalledTimes(1)
    expect(await parked()).toEqual([])
  })

  it('keeps rows while dependencies are missing, and retries on backoff', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      incoming.apply.mockResolvedValue(false)
      await healer.park(entry(1), 'missingDeps')

      await healer.runDue()
      expect(await parked()).toHaveLength(1)

      await healer.runDue()
      expect(incoming.apply).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(GAP_HEAL_DELAYS[0])
      await healer.runDue()
      expect(incoming.apply).toHaveBeenCalledTimes(2)

      await healer.runDue()
      expect(incoming.apply).toHaveBeenCalledTimes(2)
      vi.advanceTimersByTime(GAP_HEAL_DELAYS[1])
      await healer.runDue()
      expect(incoming.apply).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries at once after a later entry for the item, and after a manifest sync', async () => {
    incoming.apply.mockResolvedValue(false)
    await healer.park(entry(1), 'missingDeps')
    await healer.runDue()

    healer.onLogEntry(ITEM)
    await healer.runDue()
    expect(incoming.apply).toHaveBeenCalledTimes(2)

    healer.onManifestSynced()
    await healer.runDue()
    expect(incoming.apply).toHaveBeenCalledTimes(3)
  })

  it('keeps a row the doc applied while the doc still reports missing dependencies', async () => {
    docStore.getMissingDeps.mockResolvedValue(['missing-hash'])
    await healer.park(entry(1), 'missingDeps')

    await healer.runDue()

    expect(await parked()).toHaveLength(1)
  })

  it('tells the user after a day, keeps trying, and clears it on a heal', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      incoming.apply.mockResolvedValue(false)
      await healer.park(entry(1), 'missingDeps')
      await healer.runDue()
      expect(recoveryManager.quarantine).not.toHaveBeenCalled()

      vi.advanceTimersByTime(SYNC_TIMEOUTS.missingChangesQuarantine)
      await healer.runDue()
      expect(recoveryManager.quarantine).toHaveBeenCalledWith(
        ITEM,
        'missingChanges',
        'Waiting for changes from another device',
      )

      incoming.apply.mockResolvedValue(true)
      healer.onManifestSynced()
      await healer.runDue()
      expect(recoveryManager.resolveQuarantines).toHaveBeenCalledWith([ITEM], new Set(['missingChanges']))
      expect(await parked()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('quarantines a row that never decrypts after the retry limit, and drops it', async () => {
    keys.decryptBytes.mockRejectedValue(new Error('bad tag'))
    await healer.park(entry(1), 'decryption')

    for (let attempt = 1; attempt < MAX_PULL_RETRIES; attempt += 1) {
      expect(recoveryManager.reportDecryptionFailure).not.toHaveBeenCalled()
      healer.onManifestSynced()
      await healer.runDue()
    }

    expect(recoveryManager.reportDecryptionFailure).toHaveBeenCalledWith(ITEM, 'pullDecryption', expect.any(Error))
    expect(await parked()).toEqual([])
  })

  it('picks up parked entries after a reload', async () => {
    await healer.park(entry(1), 'missingDeps')

    const reloaded = createHealer()
    await reloaded.load()
    await reloaded.runDue()

    expect(fetchSnapshots).toHaveBeenCalledWith([ITEM], undefined)
    expect(await parked()).toEqual([])
  })

  it('fetches a snapshot on request for an indexed item with no local data', async () => {
    healer.requestSnapshot(ITEM)

    expect(onWorkDue).toHaveBeenCalled()
    await healer.runDue()

    expect(fetchSnapshots).toHaveBeenCalledWith([ITEM], undefined)
    fetchSnapshots.mockClear()
    await healer.runDue()
    expect(fetchSnapshots).not.toHaveBeenCalled()
  })

  it('lets a failed fetch fail the poll, leaving the item for the next one', async () => {
    fetchSnapshots.mockRejectedValueOnce(new Error('offline'))
    await healer.park(entry(1), 'missingDeps')

    await expect(healer.runDue()).rejects.toThrow('offline')

    await healer.runDue()
    expect(await parked()).toEqual([])
  })
})
