import { IDBFactory } from 'fake-indexeddb'
import { clearAccountLocalData, clearWriteAheadLog } from './localDataCleanup'
import * as syncMetadataStorage from '../worker/stores/syncMetadataStorage'
import { SyncWriteAheadLog } from '../worker/SyncWriteAheadLog'
import * as manualRecoveryStore from '../shared/manualRecoveryStore'
import { getAccountDatabaseName } from '../shared/createAccountStore'

vi.mock('../worker/stores/syncMetadataStorage', () => ({
  clearSyncMetadataStorage: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../worker/SyncWriteAheadLog', () => ({
  SyncWriteAheadLog: {
    clearSealed: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('../shared/manualRecoveryStore', () => ({
  clearManualRecoveryEntries: vi.fn().mockResolvedValue(undefined),
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

describe('localDataCleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does nothing if accountId is empty', async () => {
    await clearAccountLocalData('')

    expect(syncMetadataStorage.clearSyncMetadataStorage).not.toHaveBeenCalled()
    expect(SyncWriteAheadLog.clearSealed).not.toHaveBeenCalled()
  })

  it('clears sync metadata, the WAL and manual recovery entries for the account', async () => {
    await clearAccountLocalData('test-account')

    expect(syncMetadataStorage.clearSyncMetadataStorage).toHaveBeenCalledWith('test-account')
    expect(SyncWriteAheadLog.clearSealed).toHaveBeenCalledWith('test-account')
    expect(manualRecoveryStore.clearManualRecoveryEntries).toHaveBeenCalledWith('test-account')
  })

  describe('clearWriteAheadLog', () => {
    const plaintextName = getAccountDatabaseName('wal-entries', 'test-account')
    let factory: IDBFactory

    beforeEach(() => {
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
      expect(SyncWriteAheadLog.clearSealed).toHaveBeenCalledWith('test-account')
    })

    // An empty plaintext database would send the device to the migration app at its next start
    it("doesn't create the plaintext WAL database when there is none", async () => {
      await clearWriteAheadLog('test-account')

      expect(await listDatabases(factory)).toEqual([])
    })
  })
})
