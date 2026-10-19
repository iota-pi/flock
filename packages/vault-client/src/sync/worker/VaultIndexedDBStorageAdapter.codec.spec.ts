import { IDBFactory, IDBKeyRange as FakeIDBKeyRange } from 'fake-indexeddb'
import type { StorageKey } from '@automerge/automerge-repo/slim'
import { VaultIndexedDBStorageAdapter, type RecordCodec } from './VaultIndexedDBStorageAdapter'

const delay = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms))

/** Reverses the bytes and awaits a timer on both sides, as a cipher would await WebCrypto */
function createSlowCodec(): RecordCodec {
  return {
    encode: async (key, bytes) => {
      await delay()
      return { key, sealed: Uint8Array.from(bytes).reverse() }
    },
    decode: async (_key, record) => {
      await delay()
      const sealed = (record as { sealed?: Uint8Array }).sealed
      if (!sealed) throw new Error('unreadable record')
      return Uint8Array.from(sealed).reverse()
    },
  }
}

function listStores(name: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name)
    request.onsuccess = () => {
      const stores = Array.from(request.result.objectStoreNames)
      const { version } = request.result
      request.result.close()
      resolve([`v${version}`, ...stores])
    }
    request.onerror = () => reject(request.error)
  })
}

describe('VaultIndexedDBStorageAdapter with fake-indexeddb', () => {
  const originalIndexedDB = globalThis.indexedDB
  const originalKeyRange = globalThis.IDBKeyRange
  const adapters: VaultIndexedDBStorageAdapter[] = []

  const create = (...args: ConstructorParameters<typeof VaultIndexedDBStorageAdapter>) => {
    const adapter = new VaultIndexedDBStorageAdapter(...args)
    adapters.push(adapter)
    return adapter
  }

  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
    globalThis.IDBKeyRange = FakeIDBKeyRange as typeof IDBKeyRange
  })

  afterEach(async () => {
    await Promise.all(adapters.splice(0).map(adapter => adapter.close()))
    globalThis.indexedDB = originalIndexedDB
    globalThis.IDBKeyRange = originalKeyRange
  })

  it('stores plaintext records as { key, binary } by default', async () => {
    const adapter = create('plain-db')
    await adapter.save(['doc', 'snapshot', 'a'], new Uint8Array([1, 2, 3]))
    expect(await adapter.load(['doc', 'snapshot', 'a'])).toEqual(new Uint8Array([1, 2, 3]))
    await adapter.close()

    const raw = await new Promise<unknown>((resolve, reject) => {
      const request = indexedDB.open('plain-db')
      request.onsuccess = () => {
        const get = request.result.transaction('documents').objectStore('documents').get(['doc', 'snapshot', 'a'])
        get.onsuccess = () => {
          request.result.close()
          resolve(get.result)
        }
        get.onerror = () => reject(get.error)
      }
    })
    expect(raw).toEqual({ key: ['doc', 'snapshot', 'a'], binary: new Uint8Array([1, 2, 3]) })
  })

  it('round trips through a codec in load, loadRange and has', async () => {
    const decode = vi.fn(createSlowCodec().decode)
    const adapter = create('sealed-db', { version: 1, extraStores: ['meta'], codec: { ...createSlowCodec(), decode } })

    await adapter.save(['doc', 'incremental', '1'], new Uint8Array([1, 2]))
    await adapter.save(['doc', 'incremental', '2'], new Uint8Array([3, 4]))
    await adapter.save(['other', 'snapshot', '1'], new Uint8Array([9]))

    expect(await adapter.load(['doc', 'incremental', '1'])).toEqual(new Uint8Array([1, 2]))
    expect(await adapter.load(['missing'])).toBeUndefined()
    expect(await adapter.loadRange(['doc'])).toEqual([
      { key: ['doc', 'incremental', '1'], data: new Uint8Array([1, 2]) },
      { key: ['doc', 'incremental', '2'], data: new Uint8Array([3, 4]) },
    ])

    decode.mockClear()
    expect(await adapter.has(['doc'])).toBe(true)
    expect(await adapter.has(['nothing'])).toBe(false)
    expect(decode).not.toHaveBeenCalled()
  })

  it('raises no TransactionInactiveError when the codec awaits timers', async () => {
    const adapter = create('slow-db', { version: 1, extraStores: ['meta'], codec: createSlowCodec() })
    const keys: StorageKey[] = Array.from({ length: 5 }, (_, i) => ['doc', 'incremental', `${i}`])

    await Promise.all(keys.map((key, i) => adapter.save(key, new Uint8Array([i]))))
    await expect(Promise.all(keys.map(key => adapter.load(key)))).resolves.toHaveLength(5)
    await expect(adapter.loadRange(['doc'])).resolves.toHaveLength(5)
    await expect(adapter.loadPage(undefined, 2)).resolves.toHaveLength(2)
  })

  it('throws from load and loadRange when a record fails to decode, and reports it', async () => {
    const onOpenFailure = vi.fn()
    const writer = create('corrupt-db', { version: 1, extraStores: ['meta'] })
    await writer.save(['doc', 'snapshot', 'bad'], new Uint8Array([1]))
    await writer.close()

    const adapter = create('corrupt-db', { version: 1, extraStores: ['meta'], codec: createSlowCodec(), onOpenFailure })
    await expect(adapter.load(['doc', 'snapshot', 'bad'])).rejects.toThrow('unreadable record')
    await expect(adapter.loadRange(['doc'])).rejects.toThrow('unreadable record')
    expect(onOpenFailure).toHaveBeenCalledTimes(2)
    expect(onOpenFailure).toHaveBeenCalledWith(['doc', 'snapshot', 'bad'], expect.any(Error))
  })

  it('creates the document and meta stores at the given version', async () => {
    const adapter = create('versioned-db', { version: 1, extraStores: ['meta'] })
    await adapter.save(['a'], new Uint8Array([1]))
    await adapter.close()
    expect(await listStores('versioned-db')).toEqual(['v1', 'documents', 'meta'])
  })

  it('stores meta values, and addMeta rejects a key that exists', async () => {
    const adapter = create('meta-db', { version: 1, extraStores: ['meta'] })
    expect(await adapter.getMeta('upgradedAt')).toBeUndefined()

    await adapter.addMeta('dsk', { kver: '2' })
    await expect(adapter.addMeta('dsk', { kver: '3' })).rejects.toMatchObject({ name: 'ConstraintError' })
    expect(await adapter.getMeta('dsk')).toEqual({ kver: '2' })

    await adapter.putMeta('dsk', { kver: '3' })
    expect(await adapter.getMeta('dsk')).toEqual({ kver: '3' })
  })

  it('lets only one of two racing addMeta calls win', async () => {
    const adapter = create('race-db', { version: 1, extraStores: ['meta'] })
    const results = await Promise.allSettled([adapter.addMeta('dsk', 'first'), adapter.addMeta('dsk', 'second')])
    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
  })

  it('pages through chunks with an exclusive lower bound', async () => {
    const adapter = create('page-db', { version: 1, extraStores: ['meta'], codec: createSlowCodec() })
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      await adapter.save([id, 'snapshot'], new Uint8Array([id.charCodeAt(0)]))
    }

    const first = await adapter.loadPage(undefined, 2)
    expect(first.map(chunk => chunk.key)).toEqual([['a', 'snapshot'], ['b', 'snapshot']])
    const second = await adapter.loadPage(first[1].key, 2)
    expect(second.map(chunk => chunk.key)).toEqual([['c', 'snapshot'], ['d', 'snapshot']])
    expect(second[0].data).toEqual(new Uint8Array(['c'.charCodeAt(0)]))
    const last = await adapter.loadPage(second[1].key, 2)
    expect(last.map(chunk => chunk.key)).toEqual([['e', 'snapshot']])
    expect(await adapter.loadPage(last[0].key, 2)).toEqual([])
  })
})
