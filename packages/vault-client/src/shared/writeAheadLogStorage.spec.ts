import { IDBFactory } from 'fake-indexeddb'
import { clearWriteAheadLog } from './writeAheadLogStorage'
import { createDatabase, listDatabases } from '../worker/__test__/testUtils'

describe('clearWriteAheadLog', () => {
  const plaintextName = 'test-vault-wal-test-account'
  const sealedName = 'test-vault-wal-sealed-test-account'
  let factory: IDBFactory

  beforeEach(() => {
    factory = new IDBFactory()
    vi.stubGlobal('indexedDB', factory)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('deletes the plaintext and sealed WAL databases', async () => {
    await createDatabase(factory, plaintextName)
    await createDatabase(factory, sealedName)

    await clearWriteAheadLog('test-account')

    expect(await listDatabases(factory)).toEqual([])
  })

  // An empty plaintext database would send the device to the migration app at its next start
  it("doesn't create either WAL database when there is none", async () => {
    await clearWriteAheadLog('test-account')

    expect(await listDatabases(factory)).toEqual([])
  })
})
