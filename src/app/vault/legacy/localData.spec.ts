import {
  clearLegacyLocalData,
  hasLegacyDatabase,
  migrateLegacyLocalData,
  normalizeCursors,
  probeDatabaseExists,
} from './localData'
import { clearAccountStoreInstancesCacheForTesting } from '../../../sync/shared/createAccountStore'
import type { ItemId } from '../../../shared/vault/ids'
import { createMockLocalForagePool, type MockLocalforage } from '../../../sync/worker/__test__/testUtils'

const pool = createMockLocalForagePool()

vi.mock('localforage', () => ({
  default: {
    createInstance: vi.fn().mockImplementation((config: Record<string, any>) => pool.createInstance(config)),
  },
}))

vi.mock('../../../sync/utils/storageManager', () => ({
  runStorageOperation: vi.fn(async (op: () => Promise<any>) => op()),
}))

const accountId = 'acc-1'
const LEGACY_DATABASES = {
  cursors: { name: 'flock-sync-cursors', storeName: `cursors-${accountId}`, key: 'cursorByItemId' },
  indexDoc: { name: 'flock-item-metadata', storeName: `index-${accountId}`, key: 'indexDoc' },
  lastModified: { name: 'flock-sync-last-modified', storeName: `last-modified-${accountId}`, key: 'lastModifiedByItemId' },
  syncedHeads: { name: 'flock-sync-synced-heads', storeName: `synced-heads-${accountId}`, key: 'syncedHeadsByDocId' },
}
const MANUAL_RECOVERY_DB = `FlockVault_ManualRecoveryDB_${accountId}`

function metadataStore(): MockLocalforage {
  return pool.getOrCreateInstance({ name: `flock-sync-metadata-${accountId}`, storeName: 'sync-metadata' })
}

function manualRecoveryStore(): MockLocalforage {
  return pool.getOrCreateInstance({ name: MANUAL_RECOVERY_DB, storeName: 'manual-recovery-items' })
}

function manualRecoveryMetaStore(): MockLocalforage {
  return pool.getOrCreateInstance({ name: MANUAL_RECOVERY_DB, storeName: 'manual-recovery-metadata' })
}

function legacyStore(database: { name: string, storeName: string }): MockLocalforage {
  return pool.getOrCreateInstance(database)
}

function mockExistingDatabases(names: string[]) {
  const databases = vi.fn().mockResolvedValue(names.map(name => ({ name })))
  ;(globalThis as any).indexedDB = { databases }
  return databases
}

const originalIndexedDb = (globalThis as any).indexedDB

function restoreIndexedDb() {
  if (originalIndexedDb === undefined) {
    delete (globalThis as any).indexedDB
  } else {
    ;(globalThis as any).indexedDB = originalIndexedDb
  }
}

describe('migrateLegacyLocalData', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    pool.reset()
    clearAccountStoreInstancesCacheForTesting()
    // Most tests don't care about manual recovery, so mark it done
    metadataStore().data.set('manualRecoveryMigrated', true)
  })

  afterEach(restoreIndexedDb)

  it('moves values from the consolidated store\'s legacy keys to the current keys', async () => {
    const metadata = metadataStore()
    metadata.data.set('cursorByItemId', [['item-1', 50], ['item-2', 70]])
    metadata.data.set('lastModifiedByItemId', [['item-1', 4000]])
    metadata.data.set('syncedHeadsByDocId', [['doc-1', ['head-1']]])

    await migrateLegacyLocalData(accountId)

    expect(metadata.data.get('cursors')).toEqual({ globalCursor: 70, retries: [['item-1', 50], ['item-2', 70]] })
    expect(metadata.data.get('lastModified')).toEqual([
      ['item-1', { localModifiedAt: 4000, lastSnapshotAt: 4000, baseVersion: 0 }],
    ])
    expect(metadata.data.get('syncedHeads')).toEqual([['doc-1', ['head-1']]])
    expect(metadata.data.has('cursorByItemId')).toBe(false)
    expect(metadata.data.has('lastModifiedByItemId')).toBe(false)
    expect(metadata.data.has('syncedHeadsByDocId')).toBe(false)
  })

  it('moves values from the per-store databases', async () => {
    mockExistingDatabases(Object.values(LEGACY_DATABASES).map(db => db.name))
    legacyStore(LEGACY_DATABASES.cursors).data.set('cursorByItemId', [['item-1', 77]])
    legacyStore(LEGACY_DATABASES.indexDoc).data.set('indexDoc', { itemIds: ['legacy-1'] })
    legacyStore(LEGACY_DATABASES.lastModified).data.set('lastModifiedByItemId', [['item-1', 8888]])
    legacyStore(LEGACY_DATABASES.syncedHeads).data.set('syncedHeadsByDocId', [['doc-1', ['head-db']]])

    await migrateLegacyLocalData(accountId)

    const metadata = metadataStore()
    expect(metadata.data.get('cursors')).toEqual({ globalCursor: 77, retries: [['item-1', 77]] })
    expect(metadata.data.get('indexDoc')).toEqual({ itemIds: ['legacy-1'] })
    expect(metadata.data.get('lastModified')).toEqual([
      ['item-1', { localModifiedAt: 8888, lastSnapshotAt: 8888, baseVersion: 0 }],
    ])
    expect(metadata.data.get('syncedHeads')).toEqual([['doc-1', ['head-db']]])
    for (const database of Object.values(LEGACY_DATABASES)) {
      expect(legacyStore(database).data.has(database.key)).toBe(false)
    }
  })

  it('prefers the consolidated store\'s legacy key over a per-store database', async () => {
    mockExistingDatabases([LEGACY_DATABASES.syncedHeads.name])
    legacyStore(LEGACY_DATABASES.syncedHeads).data.set('syncedHeadsByDocId', [['doc-db', ['head-db']]])
    metadataStore().data.set('syncedHeadsByDocId', [['doc-key', ['head-key']]])

    await migrateLegacyLocalData(accountId)

    expect(metadataStore().data.get('syncedHeads')).toEqual([['doc-key', ['head-key']]])
  })

  it('keeps current values, drops stale legacy keys and leaves the databases alone', async () => {
    const databases = mockExistingDatabases(Object.values(LEGACY_DATABASES).map(db => db.name))
    const metadata = metadataStore()
    metadata.data.set('cursors', { globalCursor: 500 })
    metadata.data.set('indexDoc', { itemIds: ['current'] })
    metadata.data.set('lastModified', [['item-1', { localModifiedAt: 9000 }]])
    metadata.data.set('syncedHeads', [['doc-1', ['current']]])
    metadata.data.set('cursorByItemId', [['item-1', 10]])
    legacyStore(LEGACY_DATABASES.indexDoc).data.set('indexDoc', { itemIds: ['stale'] })

    await migrateLegacyLocalData(accountId)

    expect(metadata.data.get('cursors')).toEqual({ globalCursor: 500 })
    expect(metadata.data.get('indexDoc')).toEqual({ itemIds: ['current'] })
    expect(metadata.data.get('lastModified')).toEqual([['item-1', { localModifiedAt: 9000 }]])
    expect(metadata.data.get('syncedHeads')).toEqual([['doc-1', ['current']]])
    expect(metadata.data.has('cursorByItemId')).toBe(false)
    expect(databases).not.toHaveBeenCalled()
  })

  it('upgrades cursor arrays and numeric timestamps stored under the current keys', async () => {
    const metadata = metadataStore()
    metadata.data.set('cursors', [['item-1', 10], ['item-2', 100]])
    metadata.data.set('lastModified', [
      ['item-1', 5000],
      ['item-2', { localModifiedAt: 6000, lastSnapshotAt: 5500, baseVersion: 3 }],
    ])

    await migrateLegacyLocalData(accountId)

    expect(metadata.data.get('cursors')).toEqual({ globalCursor: 100, retries: [['item-1', 10], ['item-2', 100]] })
    expect(metadata.data.get('lastModified')).toEqual([
      ['item-1', { localModifiedAt: 5000, lastSnapshotAt: 5000, baseVersion: 0 }],
      ['item-2', { localModifiedAt: 6000, lastSnapshotAt: 5500, baseVersion: 3 }],
    ])
  })

  it('does not open a per-store database that does not exist', async () => {
    mockExistingDatabases([])

    await migrateLegacyLocalData(accountId)

    for (const database of Object.values(LEGACY_DATABASES)) {
      expect(pool.getInstance(database.name, database.storeName)).toBeUndefined()
    }
  })

  it('writes nothing on a second run', async () => {
    metadataStore().data.set('cursorByItemId', [['item-1', 50]])
    await migrateLegacyLocalData(accountId)
    metadataStore().setItem.mockClear()
    metadataStore().removeItem.mockClear()

    await migrateLegacyLocalData(accountId)

    expect(metadataStore().setItem).not.toHaveBeenCalled()
    expect(metadataStore().data.get('cursors')).toEqual({ globalCursor: 50, retries: [['item-1', 50]] })
  })

  it('skips a per-store database it cannot read', async () => {
    mockExistingDatabases([LEGACY_DATABASES.indexDoc.name])
    const broken = legacyStore(LEGACY_DATABASES.indexDoc)
    broken.getItem.mockRejectedValueOnce(new Error('corrupt'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(migrateLegacyLocalData(accountId)).resolves.toBeUndefined()

    expect(metadataStore().data.has('indexDoc')).toBe(false)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('propagates failures of the consolidated store', async () => {
    metadataStore().getItem.mockRejectedValueOnce(new Error('read failed'))

    await expect(migrateLegacyLocalData(accountId)).rejects.toThrow('read failed')
  })
})

describe('normalizeCursors', () => {
  it('ignores negative or non-finite values', () => {
    const raw: [ItemId, number][] = [
      ['item-1' as ItemId, 10],
      ['item-2' as ItemId, 100],
      ['item-3' as ItemId, -5],
      ['item-4' as ItemId, NaN],
      ['item-5' as ItemId, Infinity],
      ['item-6' as ItemId, 50],
    ]
    const normalized = normalizeCursors(raw)
    expect(normalized.globalCursor).toBe(100)
    expect(normalized.retries).toEqual([
      ['item-1', 10],
      ['item-2', 100],
      ['item-6', 50],
    ])
  })

  it('handles tens of thousands of items without stack overflow (no Math.max spread)', () => {
    const largeCount = 70_000
    const largeArray: [ItemId, number][] = Array.from({ length: largeCount }, (_, i) => [
      `item-${i}` as ItemId,
      i + 1,
    ])

    const normalized = normalizeCursors(largeArray)

    expect(normalized.globalCursor).toBe(largeCount)
    expect(normalized.retries?.length).toBe(largeCount)
  })
})

describe('manual recovery migration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    pool.reset()
    clearAccountStoreInstancesCacheForTesting()
  })

  it('keys legacy entries by item ID and sets the flag', async () => {
    const storage = manualRecoveryStore()
    storage.data.set('some-legacy-uuid', {
      id: 'some-legacy-uuid',
      itemId: 'legacy-item-id',
      reason: 'legacy failure',
      createdAt: 1000,
    })

    await migrateLegacyLocalData(accountId)

    expect(storage.data.has('some-legacy-uuid')).toBe(false)
    expect(storage.data.get('legacy-item-id')).toEqual({
      id: 'legacy-item-id',
      itemId: 'legacy-item-id',
      reason: 'legacy failure',
      createdAt: 1000,
    })
    expect(metadataStore().data.get('manualRecoveryMigrated')).toBe(true)
  })

  it('does not run again once the flag is set', async () => {
    metadataStore().data.set('manualRecoveryMigrated', true)
    manualRecoveryStore().data.set('uuid-2', { id: 'uuid-2', itemId: 'item-2', reason: 'x', createdAt: 1 })

    await migrateLegacyLocalData(accountId)

    expect(manualRecoveryStore().data.has('uuid-2')).toBe(true)
  })

  it('adopts the legacy __migrated_v2 flag without re-running', async () => {
    manualRecoveryMetaStore().data.set('__migrated_v2', true)
    manualRecoveryStore().data.set('unmigrated-uuid', { id: 'unmigrated-uuid', itemId: 'item-x', reason: 'test', createdAt: 1 })

    await migrateLegacyLocalData(accountId)

    expect(metadataStore().data.get('manualRecoveryMigrated')).toBe(true)
    expect(manualRecoveryMetaStore().data.has('__migrated_v2')).toBe(false)
    expect(manualRecoveryStore().data.has('unmigrated-uuid')).toBe(true)
  })

  it('merges duplicate entries for the same item without losing error context', async () => {
    const storage = manualRecoveryStore()
    storage.data.set('uuid-entry-1', {
      id: 'uuid-entry-1',
      itemId: 'duplicate-item-id',
      reason: 'Decryption failed: corrupted cipher',
      createdAt: 100_000,
    })
    storage.data.set('uuid-entry-2', {
      id: 'uuid-entry-2',
      itemId: 'duplicate-item-id',
      reason: 'Snapshot build failed: document missing',
      createdAt: 300_000,
    })
    storage.data.set('uuid-entry-3', {
      id: 'uuid-entry-3',
      itemId: 'duplicate-item-id',
      reason: 'Decryption failed: corrupted cipher',
      createdAt: 200_000,
    })

    await migrateLegacyLocalData(accountId)

    expect([...storage.data.keys()]).toEqual(['duplicate-item-id'])
    expect(storage.data.get('duplicate-item-id')).toEqual({
      id: 'duplicate-item-id',
      itemId: 'duplicate-item-id',
      reason: 'Decryption failed: corrupted cipher; Snapshot build failed: document missing',
      createdAt: 300_000,
    })
  })

  it('removes entries that are not manual recovery entries', async () => {
    manualRecoveryStore().data.set('junk', 'not-an-entry')

    await migrateLegacyLocalData(accountId)

    expect(manualRecoveryStore().data.has('junk')).toBe(false)
  })
})

describe('clearLegacyLocalData', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    pool.reset()
    clearAccountStoreInstancesCacheForTesting()
  })

  afterEach(restoreIndexedDb)

  it('clears the per-store databases that exist and the legacy manual recovery metadata', async () => {
    mockExistingDatabases([LEGACY_DATABASES.cursors.name])
    legacyStore(LEGACY_DATABASES.cursors).data.set('cursorByItemId', [['item-1', 1]])
    manualRecoveryMetaStore().data.set('__migrated_v2', true)

    await clearLegacyLocalData(accountId)

    expect(legacyStore(LEGACY_DATABASES.cursors).data.size).toBe(0)
    expect(manualRecoveryMetaStore().data.size).toBe(0)
    expect(pool.getInstance(LEGACY_DATABASES.indexDoc.name, LEGACY_DATABASES.indexDoc.storeName)).toBeUndefined()
  })

  it('does nothing without an account', async () => {
    await clearLegacyLocalData('')

    expect(pool.instances.size).toBe(0)
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
