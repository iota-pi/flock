import { IDBFactory } from 'fake-indexeddb'
import { deleteStoredSessionToken } from './workerAuthStore'
import { getVaultStorageNames } from './storageNames'

/** Stores a session token the way earlier builds did (localforage's object store) */
async function storeLegacyToken(factory: IDBFactory, name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = factory.open(name, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('keyvaluepairs')
    request.onsuccess = () => {
      const db = request.result
      const transaction = db.transaction('keyvaluepairs', 'readwrite')
      transaction.objectStore('keyvaluepairs').put('stored-session', 'active_session_token')
      transaction.oncomplete = () => {
        db.close()
        resolve()
      }
      transaction.onerror = () => reject(transaction.error)
    }
    request.onerror = () => reject(request.error)
  })
}

async function listDatabases(factory: IDBFactory): Promise<string[]> {
  return (await factory.databases()).map(db => db.name ?? '')
}

describe('workerAuthStore', () => {
  const originalIndexedDb = (globalThis as any).indexedDB
  let factory: IDBFactory

  beforeEach(() => {
    factory = new IDBFactory()
    ;(globalThis as any).indexedDB = factory
  })

  afterEach(() => {
    if (originalIndexedDb === undefined) {
      delete (globalThis as any).indexedDB
    } else {
      ;(globalThis as any).indexedDB = originalIndexedDb
    }
  })

  it('deletes a session token an earlier build stored', async () => {
    const name = getVaultStorageNames().authDatabase
    await storeLegacyToken(factory, name)
    expect(await listDatabases(factory)).toEqual([name])

    await deleteStoredSessionToken()

    expect(await listDatabases(factory)).toEqual([])
  })

  it('does not create the database when there is nothing to delete', async () => {
    await deleteStoredSessionToken()

    expect(await listDatabases(factory)).toEqual([])
  })
})
