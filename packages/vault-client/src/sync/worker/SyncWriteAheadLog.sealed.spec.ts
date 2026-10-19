import { SyncWriteAheadLog, clearWalInstancesCacheForTesting } from './SyncWriteAheadLog'
import { WorkerInternalEventHub, type WorkerInternalEvent } from './SyncEventHub'
import type { ItemId } from '@vault/shared'
import { clearQuotaRecoveryHandlerForTesting } from '../utils/storageManager'
import { getVaultStorageNames } from '../shared/storageNames'
import type { LocalCipher } from './localEncryption/LocalCipher'
import { MockLocalforage, createMockLocalForage, createTestLocalCipher } from './__test__/testUtils'

const activeStoreMap = new Map<string, MockLocalforage>()
vi.mock('localforage', () => ({
  default: {
    createInstance: vi.fn().mockImplementation((options: { name: string; storeName: string }) => {
      const key = `${options.name}:${options.storeName}`
      if (!activeStoreMap.has(key)) {
        activeStoreMap.set(key, createMockLocalForage(options))
      }
      return activeStoreMap.get(key)
    }),
  },
}))

const ACCOUNT = 'test-account'
const MESSAGE = new TextEncoder().encode('Alice prayer request')

function storeFor(prefix: 'walDatabase' | 'sealedWalDatabase'): MockLocalforage | undefined {
  const name = `${getVaultStorageNames().accountPrefixes[prefix]}${ACCOUNT}`
  return Array.from(activeStoreMap.entries()).find(([key]) => key.startsWith(`${name}:`))?.[1]
}

describe('SyncWriteAheadLog with a cipher', () => {
  let cipher: LocalCipher
  let hub: WorkerInternalEventHub
  let events: WorkerInternalEvent[]
  let wal: SyncWriteAheadLog

  beforeEach(async () => {
    activeStoreMap.clear()
    clearWalInstancesCacheForTesting()
    clearQuotaRecoveryHandlerForTesting()
    cipher = await createTestLocalCipher(ACCOUNT)
    hub = new WorkerInternalEventHub()
    events = []
    hub.subscribe(event => {
      events.push(event)
    })
    wal = new SyncWriteAheadLog(ACCOUNT, hub, { cipher })
  })

  it('writes sealed entries to the sealed store, with a readable descriptor', async () => {
    const id = await wal.append('item-1' as ItemId, MESSAGE)

    expect(storeFor('walDatabase')?.data.size ?? 0).toBe(0)
    const stored = storeFor('sealedWalDatabase')!.data.get(id)
    expect(stored).toMatchObject({ id, itemId: 'item-1', seq: 1 })
    expect(stored.data).toBeUndefined()
    expect(stored.sealed.v).toBe(1)
    expect(Buffer.from(stored.sealed.ct).includes(Buffer.from(MESSAGE))).toBe(false)
  })

  it('reads back what it wrote', async () => {
    const id = await wal.append('item-1' as ItemId, MESSAGE)

    const entries = await wal.readAll()

    expect(entries.get('item-1' as ItemId)).toEqual([expect.objectContaining({ id, data: MESSAGE })])
  })

  it('keeps entries sealed through compaction', async () => {
    await wal.append('item-1' as ItemId, new Uint8Array([1]))
    await wal.append('item-1' as ItemId, new Uint8Array([2]))

    expect(await wal.compact()).toBe(1)

    const stored = Array.from(storeFor('sealedWalDatabase')!.data.values())
    expect(stored).toHaveLength(1)
    expect(stored[0].isBatched).toBe(true)
    expect(stored[0].data).toBeUndefined()
    const entries = (await wal.readAll()).get('item-1' as ItemId)!
    expect(entries).toHaveLength(1)
    expect(entries[0].id).toBe(stored[0].id)
  })

  it('skips an entry that cannot be opened, reports it and asks for a snapshot instead', async () => {
    const goodId = await wal.append('item-1' as ItemId, MESSAGE)
    const badId = await wal.append('item-2' as ItemId, MESSAGE)
    const store = storeFor('sealedWalDatabase')!
    const bad = store.data.get(badId)
    bad.sealed.ct[0] ^= 1

    const entries = await wal.readAll()

    expect(Array.from(entries.keys())).toEqual(['item-1'])
    expect(entries.get('item-1' as ItemId)![0].id).toBe(goodId)
    expect(store.data.has(badId)).toBe(true)
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'localDecryptionFailed', itemId: 'item-2' }),
      { type: 'snapshotFallbackRequested', itemId: 'item-2' },
    ]))
  })

  it('refuses an entry moved to another item', async () => {
    const id = await wal.append('item-1' as ItemId, MESSAGE)
    const store = storeFor('sealedWalDatabase')!
    store.data.set(id, { ...store.data.get(id), itemId: 'item-2' })

    const entries = await wal.readAll()

    expect(entries.size).toBe(0)
  })

  it('keeps the entries an unreadable compacted entry replaced', async () => {
    const firstId = await wal.append('item-1' as ItemId, new Uint8Array([1]))
    const secondId = await wal.append('item-1' as ItemId, new Uint8Array([2]))
    const store = storeFor('sealedWalDatabase')!
    const replacement = await cipher.seal({ store: 'wal', entryId: 'compacted', itemId: 'item-1' }, new Uint8Array([9]))
    replacement.ct[0] ^= 1
    store.data.set('compacted', {
      id: 'compacted', itemId: 'item-1', sealed: replacement, createdAt: Date.now(), seq: 3, isBatched: true,
      replaces: [firstId, secondId],
    })

    const entries = (await wal.readAll()).get('item-1' as ItemId)!

    expect(entries.map(entry => entry.id)).toEqual([firstId, secondId])
    expect(store.data.has(firstId)).toBe(true)
  })

  it('leaves the plaintext store alone', async () => {
    const plain = new SyncWriteAheadLog(ACCOUNT, hub)
    await plain.append('item-1' as ItemId, MESSAGE)

    expect((await wal.readAll()).size).toBe(0)
    expect((await plain.readAll()).size).toBe(1)
  })

  it('is cleared without an instance', async () => {
    await wal.append('item-1' as ItemId, MESSAGE)

    await SyncWriteAheadLog.clearSealed(ACCOUNT)

    expect(storeFor('sealedWalDatabase')!.data.size).toBe(0)
  })
})
