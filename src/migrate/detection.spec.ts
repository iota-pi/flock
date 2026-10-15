import {
  deferMigration,
  hasLegacyDatabase,
  hasLegacyLocalData,
  isMigrationDeferred,
  probeDatabaseExists,
} from './detection'

describe('migration deferral', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('defers the account-level check for one account, for 30 days', () => {
    const now = 1_000_000
    deferMigration('acct-1', now)

    expect(isMigrationDeferred('acct-1', now + 29 * 24 * 60 * 60 * 1000)).toBe(true)
    expect(isMigrationDeferred('acct-1', now + 31 * 24 * 60 * 60 * 1000)).toBe(false)
    expect(isMigrationDeferred('acct-2', now)).toBe(false)
  })

  it('treats unreadable storage as not deferred', () => {
    localStorage.setItem('flock-migration-deferred', 'not json')
    expect(isMigrationDeferred('acct-1')).toBe(false)
  })
})

describe('hasLegacyLocalData', () => {
  const originalIndexedDb = (globalThis as any).indexedDB

  afterEach(() => {
    ;(globalThis as any).indexedDB = originalIndexedDb
  })

  it('finds any of the per-store databases', async () => {
    ;(globalThis as any).indexedDB = {
      databases: vi.fn().mockResolvedValue([{ name: 'other' }, { name: 'flock-sync-last-modified' }]),
    }
    expect(await hasLegacyLocalData()).toBe(true)
  })

  it('is false without them', async () => {
    ;(globalThis as any).indexedDB = { databases: vi.fn().mockResolvedValue([{ name: 'other' }]) }
    expect(await hasLegacyLocalData()).toBe(false)
  })
})

describe('hasLegacyDatabase and probeDatabaseExists', () => {
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
    expect(await hasLegacyDatabase('some-db')).toBe(false)
    expect(await probeDatabaseExists('some-db')).toBe(false)
  })

  it('probeDatabaseExists returns false when indexedDB.open is missing', async () => {
    ;(globalThis as any).indexedDB = {}
    expect(await probeDatabaseExists('some-db')).toBe(false)
  })

  it('probeDatabaseExists returns true and closes database when onsuccess fires', async () => {
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
    const exists = await probeDatabaseExists('existing-db')
    expect(exists).toBe(true)
    expect(mockClose).toHaveBeenCalledTimes(1)
  })

  it('probeDatabaseExists returns false, aborts transaction, and calls deleteDatabase when oldVersion === 0', async () => {
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
    const exists = await probeDatabaseExists('non-existent-db')
    expect(exists).toBe(false)
    expect(mockAbort).toHaveBeenCalled()
    expect(mockDelete).toHaveBeenCalledWith('non-existent-db')
  })

  it('probeDatabaseExists returns true when oldVersion > 0 in onupgradeneeded', async () => {
    ;(globalThis as any).indexedDB = {
      open: vi.fn().mockImplementation(() => {
        const req: any = {}
        setTimeout(() => {
          req.onupgradeneeded?.({ oldVersion: 1, target: {} })
        }, 0)
        return req
      }),
    }
    const exists = await probeDatabaseExists('upgraded-db')
    expect(exists).toBe(true)
  })

  it('probeDatabaseExists returns false on error and prevents default', async () => {
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
    const exists = await probeDatabaseExists('failing-db')
    expect(exists).toBe(false)
    expect(preventDefault).toHaveBeenCalled()
  })

  it('probeDatabaseExists returns true onblocked', async () => {
    ;(globalThis as any).indexedDB = {
      open: vi.fn().mockImplementation(() => {
        const req: any = {}
        setTimeout(() => {
          req.onblocked?.()
        }, 0)
        return req
      }),
    }
    const exists = await probeDatabaseExists('blocked-db')
    expect(exists).toBe(true)
  })

  it('probeDatabaseExists returns false if indexedDB.open throws synchronously', async () => {
    ;(globalThis as any).indexedDB = {
      open: vi.fn().mockImplementation(() => {
        throw new Error('Access denied')
      }),
    }
    const exists = await probeDatabaseExists('throwing-db')
    expect(exists).toBe(false)
  })

  it('hasLegacyDatabase uses indexedDB.databases() when available and returns match', async () => {
    ;(globalThis as any).indexedDB = {
      databases: vi.fn().mockResolvedValue([{ name: 'found-db' }, { name: 'other-db' }]),
      open: vi.fn(),
    }
    expect(await hasLegacyDatabase('found-db')).toBe(true)
    expect(await hasLegacyDatabase('missing-db')).toBe(false)
    expect((globalThis as any).indexedDB.open).not.toHaveBeenCalled()
  })

  it('hasLegacyDatabase falls back to probeDatabaseExists when indexedDB.databases() rejects', async () => {
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
    expect(await hasLegacyDatabase('legacy-target')).toBe(true)
    expect(await hasLegacyDatabase('other-target')).toBe(false)
  })

  it('hasLegacyDatabase falls back to probeDatabaseExists when indexedDB.databases is undefined', async () => {
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
    expect(await hasLegacyDatabase('firefox-legacy')).toBe(true)
    expect(await hasLegacyDatabase('firefox-missing')).toBe(false)
  })
})
