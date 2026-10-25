import { IDBFactory } from 'fake-indexeddb'
import { clearWriteAheadLog } from './writeAheadLogStorage'
import { clearAccountStoreInstancesCacheForTesting, createAccountStore, getAccountDatabaseName } from './createAccountStore'
import { createMockLocalForage, type MockLocalforage } from '../worker/__test__/testUtils'

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

async function createDatabase(factory: IDBFactory, name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = factory.open(name, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('wal-entries')
    request.onsuccess = () => {
      request.result.close()
      resolve()
    }
    request.onerror = () => reject(request.error)
  })
}

async function listDatabases(factory: IDBFactory): Promise<string[]> {
  return (await factory.databases()).map(db => db.name ?? '')
}

describe('clearWriteAheadLog', () => {
  const plaintextName = getAccountDatabaseName('wal-entries', 'test-account')
  let factory: IDBFactory

  beforeEach(() => {
    activeStoreMap.clear()
    clearAccountStoreInstancesCacheForTesting()
    factory = new IDBFactory()
    vi.stubGlobal('indexedDB', factory)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('deletes the plaintext WAL database', async () => {
    await createDatabase(factory, plaintextName)

    await clearWriteAheadLog('test-account')

    expect(await listDatabases(factory)).not.toContain(plaintextName)
  })

  // An empty plaintext database would send the device to the migration app at its next start
  it("doesn't create the plaintext WAL database when there is none", async () => {
    await clearWriteAheadLog('test-account')

    expect(await listDatabases(factory)).toEqual([])
    expect([...activeStoreMap.keys()].some(key => key.endsWith(':wal-entries'))).toBe(false)
  })

  it('clears the sealed WAL store', async () => {
    const sealed = createAccountStore('wal-entries-sealed', 'test-account')
    await sealed.setItem('entry-1', { id: 'entry-1' })

    await clearWriteAheadLog('test-account')

    expect(await sealed.length()).toBe(0)
  })
})
