import { IDBFactory } from 'fake-indexeddb'
import { clearWriteAheadLog } from './writeAheadLogStorage'
import { clearAccountStoreInstancesCacheForTesting, createAccountStore, getAccountDatabaseName } from './createAccountStore'
import { createDatabase, createMockLocalForage, listDatabases, type MockLocalforage, mockLocalForage } from '../worker/__test__/testUtils'

const activeStoreMap = new Map<string, MockLocalforage>()
const createLocalForageInstance = (options: { name: string; storeName: string }) => {
  const key = `${options.name}:${options.storeName}`
  if (!activeStoreMap.has(key)) {
    activeStoreMap.set(key, createMockLocalForage(options))
  }
  return activeStoreMap.get(key)
}

describe('clearWriteAheadLog', () => {
  const plaintextName = getAccountDatabaseName('wal-entries', 'test-account')
  let factory: IDBFactory

  beforeEach(() => {
    mockLocalForage(createLocalForageInstance)
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
