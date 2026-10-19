import { IDBFactory } from 'fake-indexeddb'
import { databaseExists } from './databaseExists'

async function createDatabase(factory: IDBFactory, name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = factory.open(name, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('documents')
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

describe('databaseExists', () => {
  const originalIndexedDb = (globalThis as any).indexedDB

  afterEach(() => {
    if (originalIndexedDb === undefined) {
      delete (globalThis as any).indexedDB
    } else {
      ;(globalThis as any).indexedDB = originalIndexedDb
    }
  })

  it('returns false when indexedDB is undefined', async () => {
    delete (globalThis as any).indexedDB
    expect(await databaseExists('some-db')).toBe(false)
  })

  it('finds an existing database and creates no missing one, with indexedDB.databases()', async () => {
    const factory = new IDBFactory()
    ;(globalThis as any).indexedDB = factory
    await createDatabase(factory, 'present')

    expect(await databaseExists('present')).toBe(true)
    expect(await databaseExists('absent')).toBe(false)
    expect(await listDatabases(factory)).toEqual(['present'])
  })

  it('finds an existing database and creates no missing one, with only the probe', async () => {
    const factory = new IDBFactory()
    ;(globalThis as any).indexedDB = {
      open: (name: string) => factory.open(name),
      deleteDatabase: (name: string) => factory.deleteDatabase(name),
    }
    await createDatabase(factory, 'present')

    expect(await databaseExists('present')).toBe(true)
    expect(await databaseExists('absent')).toBe(false)
    expect(await listDatabases(factory)).toEqual(['present'])
  })

  it('the probe returns false when indexedDB.open is missing', async () => {
    ;(globalThis as any).indexedDB = {}
    expect(await databaseExists('some-db')).toBe(false)
  })

  it('the probe returns true and closes database when onsuccess fires', async () => {
    const mockClose = vi.fn()
    ;(globalThis as any).indexedDB = {
      open: vi.fn().mockImplementation(() => {
        const req: any = {}
        setTimeout(() => {
          req.onsuccess?.({ target: { result: { close: mockClose } } })
        }, 0)
        return req
      }),
    }
    const exists = await databaseExists('existing-db')
    expect(exists).toBe(true)
    expect(mockClose).toHaveBeenCalledTimes(1)
  })

  it('the probe returns false, aborts transaction, and calls deleteDatabase when oldVersion === 0', async () => {
    const mockAbort = vi.fn()
    const mockDelete = vi.fn()
    ;(globalThis as any).indexedDB = {
      deleteDatabase: mockDelete,
      open: vi.fn().mockImplementation(() => {
        const req: any = {
          transaction: { abort: mockAbort },
        }
        setTimeout(() => {
          req.onupgradeneeded?.({
            oldVersion: 0,
            target: { transaction: { abort: mockAbort } },
          })
        }, 0)
        return req
      }),
    }
    const exists = await databaseExists('non-existent-db')
    expect(exists).toBe(false)
    expect(mockAbort).toHaveBeenCalled()
    expect(mockDelete).toHaveBeenCalledWith('non-existent-db')
  })

  it('the probe returns true when oldVersion > 0 in onupgradeneeded', async () => {
    ;(globalThis as any).indexedDB = {
      open: vi.fn().mockImplementation(() => {
        const req: any = {}
        setTimeout(() => {
          req.onupgradeneeded?.({ oldVersion: 1, target: {} })
        }, 0)
        return req
      }),
    }
    const exists = await databaseExists('upgraded-db')
    expect(exists).toBe(true)
  })

  it('the probe returns false on error and prevents default', async () => {
    const preventDefault = vi.fn()
    const stopPropagation = vi.fn()
    ;(globalThis as any).indexedDB = {
      open: vi.fn().mockImplementation(() => {
        const req: any = {}
        setTimeout(() => {
          req.onerror?.({ preventDefault, stopPropagation })
        }, 0)
        return req
      }),
    }
    const exists = await databaseExists('failing-db')
    expect(exists).toBe(false)
    expect(preventDefault).toHaveBeenCalled()
  })

  it('the probe returns true onblocked', async () => {
    ;(globalThis as any).indexedDB = {
      open: vi.fn().mockImplementation(() => {
        const req: any = {}
        setTimeout(() => {
          req.onblocked?.()
        }, 0)
        return req
      }),
    }
    const exists = await databaseExists('blocked-db')
    expect(exists).toBe(true)
  })

  it('the probe returns false if indexedDB.open throws synchronously', async () => {
    ;(globalThis as any).indexedDB = {
      open: vi.fn().mockImplementation(() => {
        throw new Error('Access denied')
      }),
    }
    const exists = await databaseExists('throwing-db')
    expect(exists).toBe(false)
  })

  it('uses indexedDB.databases() when available and returns match', async () => {
    ;(globalThis as any).indexedDB = {
      databases: vi.fn().mockResolvedValue([{ name: 'found-db' }, { name: 'other-db' }]),
      open: vi.fn(),
    }
    expect(await databaseExists('found-db')).toBe(true)
    expect(await databaseExists('missing-db')).toBe(false)
    expect((globalThis as any).indexedDB.open).not.toHaveBeenCalled()
  })

  it('falls back to the probe when indexedDB.databases() rejects', async () => {
    const mockClose = vi.fn()
    ;(globalThis as any).indexedDB = {
      databases: vi.fn().mockRejectedValue(new Error('Safari WebKit worker restriction')),
      open: vi.fn().mockImplementation((name: string) => {
        const req: any = {}
        setTimeout(() => {
          if (name === 'legacy-target') {
            req.onsuccess?.({ target: { result: { close: mockClose } } })
          } else {
            req.onupgradeneeded?.({ oldVersion: 0, target: { transaction: { abort: vi.fn() } } })
          }
        }, 0)
        return req
      }),
    }
    expect(await databaseExists('legacy-target')).toBe(true)
    expect(await databaseExists('other-target')).toBe(false)
  })

  it('falls back to the probe when indexedDB.databases is undefined', async () => {
    const mockClose = vi.fn()
    ;(globalThis as any).indexedDB = {
      open: vi.fn().mockImplementation((name: string) => {
        const req: any = {}
        setTimeout(() => {
          if (name === 'firefox-legacy') {
            req.onsuccess?.({ target: { result: { close: mockClose } } })
          } else {
            req.onerror?.({ preventDefault: vi.fn() })
          }
        }, 0)
        return req
      }),
    }
    expect(await databaseExists('firefox-legacy')).toBe(true)
    expect(await databaseExists('firefox-missing')).toBe(false)
  })
})
