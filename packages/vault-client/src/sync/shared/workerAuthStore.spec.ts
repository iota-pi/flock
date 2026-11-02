import { IDBFactory } from 'fake-indexeddb'
import { deleteStoredSessionToken } from './workerAuthStore'
import { getVaultStorageNames } from './storageNames'
import { listDatabases } from '../worker/__test__/testUtils'

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

describe('workerAuthStore', () => {
  const originalIndexedDb = (globalThis as any).indexedDB
  let factory: IDBFactory

  beforeEach(() => {
    factory = new IDBFactory()
    ;(globalThis as any).indexedDB = factory
  })

  /** Deletion isn't awaited, so this waits for the request it sends */
  async function deleteAndSettle(): Promise<void> {
    const deleteSpy = vi.spyOn(factory, 'deleteDatabase')
    deleteStoredSessionToken()
    const request = deleteSpy.mock.results[0].value as IDBOpenDBRequest
    await vi.waitFor(() => expect(request.readyState).toBe('done'))
  }

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

    await deleteAndSettle()

    expect(await listDatabases(factory)).toEqual([])
  })

  it('does not create the database when there is nothing to delete', async () => {
    await deleteAndSettle()

    expect(await listDatabases(factory)).toEqual([])
  })
})
