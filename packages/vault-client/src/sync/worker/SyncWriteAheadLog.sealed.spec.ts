import { SyncWriteAheadLog } from './SyncWriteAheadLog'
import { WorkerInternalEventHub, type WorkerInternalEvent } from './SyncEventHub'
import type { ItemId } from '@vault/shared'
import { clearQuotaRecoveryHandlerForTesting } from '../utils/storageManager'
import { getVaultStorageNames } from '../shared/storageNames'
import { clearWriteAheadLog } from '../shared/writeAheadLogStorage'
import type { LocalCipher } from './localEncryption/LocalCipher'
import { MockLocalforage, createMockLocalForage, createTestLocalCipher, mockLocalForage } from './__test__/testUtils'
import { clearAccountStoreInstancesCacheForTesting } from '../shared/createAccountStore'

const activeStoreMap = new Map<string, MockLocalforage>()
const createLocalForageInstance = (options: { name: string; storeName: string }) => {
  const key = `${options.name}:${options.storeName}`
  if (!activeStoreMap.has(key)) {
    activeStoreMap.set(key, createMockLocalForage(options))
  }
  return activeStoreMap.get(key)
}

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
    mockLocalForage(createLocalForageInstance)
    activeStoreMap.clear()
    clearAccountStoreInstancesCacheForTesting()
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

  function corrupt(id: string): void {
    storeFor('sealedWalDatabase')!.data.get(id).sealed.ct[0] ^= 1
  }

  it('skips an entry that cannot be opened and asks for a snapshot instead', async () => {
    const goodId = await wal.append('item-1' as ItemId, MESSAGE)
    const badId = await wal.append('item-2' as ItemId, MESSAGE)
    const store = storeFor('sealedWalDatabase')!
    corrupt(badId)

    const entries = await wal.readAll()

    expect(Array.from(entries.keys())).toEqual(['item-1'])
    expect(entries.get('item-1' as ItemId)![0].id).toBe(goodId)
    expect(store.data.has(badId)).toBe(true)
    expect(events).toEqual([{ type: 'snapshotFallbackRequested', itemId: 'item-2' }])
  })

  it('does not quarantine the item for an unreadable entry, since the document itself is readable', async () => {
    const badId = await wal.append('item-2' as ItemId, MESSAGE)
    corrupt(badId)

    await wal.readAll()
    await wal.readAll()

    expect(events.some(event => event.type === 'localDecryptionFailed')).toBe(false)
  })

  it('asks for a snapshot once per unreadable entry, however often it is read', async () => {
    const goodId = await wal.append('item-1' as ItemId, MESSAGE)
    const firstBadId = await wal.append('item-2' as ItemId, MESSAGE)
    const secondBadId = await wal.append('item-3' as ItemId, MESSAGE)
    corrupt(firstBadId)
    corrupt(secondBadId)

    await wal.readAll()
    await wal.readAll()
    const entries = await wal.readAll()

    expect(events.filter(event => event.type === 'snapshotFallbackRequested')).toEqual(expect.arrayContaining([
      { type: 'snapshotFallbackRequested', itemId: 'item-2' },
      { type: 'snapshotFallbackRequested', itemId: 'item-3' },
    ]))
    expect(events).toHaveLength(2)
    expect(entries.get('item-1' as ItemId)).toEqual([expect.objectContaining({ id: goodId, data: MESSAGE })])
  })

  it('reports a newly unreadable entry for an item that already had one', async () => {
    const firstBadId = await wal.append('item-2' as ItemId, MESSAGE)
    corrupt(firstBadId)
    await wal.readAll()
    const secondBadId = await wal.append('item-2' as ItemId, MESSAGE)
    corrupt(secondBadId)

    await wal.readAll()

    expect(events).toEqual([
      { type: 'snapshotFallbackRequested', itemId: 'item-2' },
      { type: 'snapshotFallbackRequested', itemId: 'item-2' },
    ])
  })

  it('still prunes and removes unreadable entries', async () => {
    const badId = await wal.append('item-2' as ItemId, MESSAGE)
    const otherBadId = await wal.append('item-3' as ItemId, MESSAGE)
    corrupt(badId)
    corrupt(otherBadId)
    await wal.readAll()
    const store = storeFor('sealedWalDatabase')!

    await wal.handleQuotaExceeded()
    expect(store.data.has(badId)).toBe(false)
    expect(store.data.has(otherBadId)).toBe(false)
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'walEntriesPruned' }),
    ]))
  })

  it('does not mark an unreadable entry in flight or block readable entries of the same item', async () => {
    const badId = await wal.append('item-1' as ItemId, MESSAGE)
    const goodId = await wal.append('item-1' as ItemId, MESSAGE)
    corrupt(badId)

    const entries = (await wal.readAll()).get('item-1' as ItemId)!

    expect(entries.map(entry => entry.id)).toEqual([goodId])
    expect(wal.isInFlight(badId)).toBe(false)
  })

  it('refuses an entry moved to another item', async () => {
    const id = await wal.append('item-1' as ItemId, MESSAGE)
    const store = storeFor('sealedWalDatabase')!
    store.data.set(id, { ...store.data.get(id), itemId: 'item-2' })

    const entries = await wal.readAll()

    expect(entries.size).toBe(0)
  })

  it('leaves the plaintext store alone', async () => {
    const plain = new SyncWriteAheadLog(ACCOUNT, hub)
    await plain.append('item-1' as ItemId, MESSAGE)

    expect((await wal.readAll()).size).toBe(0)
    expect((await plain.readAll()).size).toBe(1)
  })

  it('is cleared without an instance', async () => {
    await wal.append('item-1' as ItemId, MESSAGE)

    await clearWriteAheadLog(ACCOUNT)

    expect(storeFor('sealedWalDatabase')!.data.size).toBe(0)
  })
})
