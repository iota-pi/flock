import localforage from 'localforage'
import { getSyncMetadataStorage } from '../worker/stores/syncMetadataStorage'

// Intercept created instances before importing manualRecoveryStore
const createdInstances: any[] = []
const originalCreateInstance = localforage.createInstance
localforage.createInstance = function (options: any) {
  const instance = originalCreateInstance.call(this, options)
  createdInstances.push(instance)
  return instance
}

const mockReportQuotaExceeded = vi.fn()
vi.mock('../../utils/storageManager', () => ({
  runStorageOperation: vi.fn(async (op: any) => {
    try {
      return await op()
    } catch (err) {
      mockReportQuotaExceeded()
      throw err
    }
  }),
  reportQuotaExceeded: (...args: any[]) => mockReportQuotaExceeded(...args),
}))

let clearInstancesCacheForTesting: any
let clearManualRecoveryEntries: any
let readManualRecoveryCount: any
let readManualRecoveryEntries: any
let removeManualRecoveryEntryById: any
let removeManualRecoveryEntryByItemId: any
let resetMigrationForTesting: any
let upsertManualRecoveryEntry: any

describe('manualRecoveryStore', () => {
  const accountId = 'test-account-id'

  beforeAll(async () => {
    const mod = await import('./manualRecoveryStore')
    clearInstancesCacheForTesting = mod.clearInstancesCacheForTesting
    clearManualRecoveryEntries = mod.clearManualRecoveryEntries
    readManualRecoveryCount = mod.readManualRecoveryCount
    readManualRecoveryEntries = mod.readManualRecoveryEntries
    removeManualRecoveryEntryById = mod.removeManualRecoveryEntryById
    removeManualRecoveryEntryByItemId = mod.removeManualRecoveryEntryByItemId
    resetMigrationForTesting = mod.resetMigrationForTesting
    upsertManualRecoveryEntry = mod.upsertManualRecoveryEntry
  })
  beforeEach(async () => {
    createdInstances.length = 0
    if (clearInstancesCacheForTesting) {
      clearInstancesCacheForTesting()
    }
    resetMigrationForTesting()
    await clearManualRecoveryEntries(accountId)
    // Also clean up consolidated metadata store and legacy metadata store
    const metaStorage = getSyncMetadataStorage(accountId)
    await metaStorage.clear()
    const legacyMetaStorage = localforage.createInstance({
      name: 'FlockVault_ManualRecoveryDB_test-account-id',
      storeName: 'manual-recovery-metadata',
    })
    await legacyMetaStorage.clear()
  })

  it('upserts entries by item id and updates count', async () => {
    await upsertManualRecoveryEntry(accountId, { itemId: 'item-1', reason: 'first failure' })
    await upsertManualRecoveryEntry(accountId, { itemId: 'item-1', reason: 'second failure' })

    const entries = await readManualRecoveryEntries(accountId)
    expect(entries).toHaveLength(1)
    expect(entries[0].itemId).toBe('item-1')
    expect(entries[0].reason).toBe('second failure')
    expect(await readManualRecoveryCount(accountId)).toBe(1)
  })

  it('removes entries by id and by item id', async () => {
    const first = await upsertManualRecoveryEntry(accountId, { itemId: 'item-1', reason: 'failed' })
    await upsertManualRecoveryEntry(accountId, { itemId: 'item-2', reason: 'failed' })

    await removeManualRecoveryEntryById(accountId, first.id)
    expect(await readManualRecoveryCount(accountId)).toBe(1)

    await removeManualRecoveryEntryByItemId(accountId, 'item-2')
    expect(await readManualRecoveryCount(accountId)).toBe(0)
  })

  it('migrates legacy entries to use itemId as key and id', async () => {
    const legacyKey = 'some-legacy-uuid'
    const legacyEntry = {
      id: legacyKey,
      itemId: 'legacy-item-id',
      reason: 'legacy failure',
      createdAt: Date.now() - 1000,
    }

    const legacyStorage = localforage.createInstance({
      name: 'FlockVault_ManualRecoveryDB_test-account-id',
      storeName: 'manual-recovery-items',
    })
    const metaStorage = localforage.createInstance({
      name: 'flock-sync-metadata-test-account-id',
      storeName: 'sync-metadata',
    })

    // Write a legacy entry directly to bypass ensureMigrated
    await legacyStorage.setItem(legacyKey, legacyEntry)
    // Clear migration flag and reset cached promise
    await metaStorage.removeItem('manualRecoveryMigrated')
    resetMigrationForTesting()

    // Trigger migration by doing an operation
    const entries = await readManualRecoveryEntries(accountId)

    // Assert migration happened
    expect(entries).toHaveLength(1)
    expect(entries[0].id).toBe('legacy-item-id')
    expect(entries[0].itemId).toBe('legacy-item-id')
    expect(await metaStorage.getItem('manualRecoveryMigrated')).toBe(true)

    // Assert legacy key is deleted, new key exists
    const oldVal = await legacyStorage.getItem(legacyKey)
    expect(oldVal).toBeNull()
    const newVal = await legacyStorage.getItem('legacy-item-id')
    expect(newVal).not.toBeNull()

    // Write another legacy entry directly (simulating a new legacy entry post-migration)
    await legacyStorage.setItem('uuid-2', {
      id: 'uuid-2',
      itemId: 'legacy-item-2',
      reason: 'another one',
      createdAt: Date.now(),
    })

    // Run operation again. Since flagged as migrated, it shouldn't run migration again
    await readManualRecoveryEntries(accountId)
    const notMigratedVal = await legacyStorage.getItem('legacy-item-2')
    expect(notMigratedVal).toBeNull()
    const stillLegacyVal = await legacyStorage.getItem('uuid-2')
    expect(stillLegacyVal).not.toBeNull()
  })

  it('migrates legacy __migrated_v2 flag from manual-recovery-metadata into syncMetadataStorage without re-running migration', async () => {
    const legacyStorage = localforage.createInstance({
      name: 'FlockVault_ManualRecoveryDB_test-account-id',
      storeName: 'manual-recovery-items',
    })
    const legacyMetaStorage = localforage.createInstance({
      name: 'FlockVault_ManualRecoveryDB_test-account-id',
      storeName: 'manual-recovery-metadata',
    })
    const metaStorage = localforage.createInstance({
      name: 'flock-sync-metadata-test-account-id',
      storeName: 'sync-metadata',
    })

    // Legacy flag set in legacy meta store
    await legacyMetaStorage.setItem('__migrated_v2', true)
    await metaStorage.removeItem('manualRecoveryMigrated')
    resetMigrationForTesting()

    // Add an entry with mismatched key that would have been migrated if migration ran
    await legacyStorage.setItem('unmigrated-uuid', {
      id: 'unmigrated-uuid',
      itemId: 'item-x',
      reason: 'test',
      createdAt: Date.now(),
    })

    await readManualRecoveryEntries(accountId)

    // Migration flag should now be adopted in syncMetadataStorage
    expect(await metaStorage.getItem('manualRecoveryMigrated')).toBe(true)
    // Legacy store cleared
    expect(await legacyMetaStorage.getItem('__migrated_v2')).toBeNull()
    // unmigrated-uuid should still be present because migration was bypassed via legacy flag
    expect(await legacyStorage.getItem('unmigrated-uuid')).not.toBeNull()
  })

  it('merges duplicate legacy entries for the same itemId without losing error context', async () => {
    const legacyStorage = localforage.createInstance({
      name: 'FlockVault_ManualRecoveryDB_test-account-id',
      storeName: 'manual-recovery-items',
    })
    const metaStorage = localforage.createInstance({
      name: 'flock-sync-metadata-test-account-id',
      storeName: 'sync-metadata',
    })

    const t1 = 100_000
    const t2 = 200_000
    const t3 = 300_000

    // Add three entries for the same item: two different errors, one duplicate error
    await legacyStorage.setItem('uuid-entry-1', {
      id: 'uuid-entry-1',
      itemId: 'duplicate-item-id',
      reason: 'Decryption failed: corrupted cipher',
      createdAt: t1,
    })
    await legacyStorage.setItem('uuid-entry-2', {
      id: 'uuid-entry-2',
      itemId: 'duplicate-item-id',
      reason: 'Snapshot build failed: document missing',
      createdAt: t3,
    })
    await legacyStorage.setItem('uuid-entry-3', {
      id: 'uuid-entry-3',
      itemId: 'duplicate-item-id',
      reason: 'Decryption failed: corrupted cipher',
      createdAt: t2,
    })

    await metaStorage.removeItem('manualRecoveryMigrated')
    resetMigrationForTesting()

    const entries = await readManualRecoveryEntries(accountId)
    expect(entries).toHaveLength(1)

    const entry = entries[0]
    expect(entry.id).toBe('duplicate-item-id')
    expect(entry.itemId).toBe('duplicate-item-id')
    // Chronological combination of unique reasons
    expect(entry.reason).toBe('Decryption failed: corrupted cipher; Snapshot build failed: document missing')
    // Latest timestamp preserved
    expect(entry.createdAt).toBe(t3)

    // Old keys should be removed
    expect(await legacyStorage.getItem('uuid-entry-1')).toBeNull()
    expect(await legacyStorage.getItem('uuid-entry-2')).toBeNull()
    expect(await legacyStorage.getItem('uuid-entry-3')).toBeNull()

    // New key exists in storage
    const stored = await legacyStorage.getItem<any>('duplicate-item-id')
    expect(stored).not.toBeNull()
    expect(stored.reason).toBe('Decryption failed: corrupted cipher; Snapshot build failed: document missing')
  })

  it('sorts entries by createdAt descending, then by id lexicographically', async () => {
    const now = Date.now()
    const dateSpy = vi.spyOn(Date, 'now')

    dateSpy.mockReturnValueOnce(now - 1000)
    await upsertManualRecoveryEntry(accountId, { itemId: 'item-b', reason: 'error-b' })

    dateSpy.mockReturnValueOnce(now)
    await upsertManualRecoveryEntry(accountId, { itemId: 'item-c', reason: 'error-c' })

    dateSpy.mockReturnValueOnce(now - 1000)
    await upsertManualRecoveryEntry(accountId, { itemId: 'item-a', reason: 'error-a' })

    const entries = await readManualRecoveryEntries(accountId)
    expect(entries).toHaveLength(3)

    expect(entries[0].itemId).toBe('item-c')
    expect(entries[1].itemId).toBe('item-a')
    expect(entries[2].itemId).toBe('item-b')

    dateSpy.mockRestore()
  })

  it('handles quota errors in upsertManualRecoveryEntry', async () => {
    const quotaError = new DOMException('quota exceeded', 'QuotaExceededError')
    const storage = createdInstances.find(i => i.config?.().name === 'FlockVault_ManualRecoveryDB_test-account-id' && i.config?.().storeName === 'manual-recovery-items')
    const setItemSpy = vi.spyOn(storage, 'setItem').mockRejectedValueOnce(quotaError)

    await expect(
      upsertManualRecoveryEntry(accountId, { itemId: 'item-quota', reason: 'quota' })
    ).rejects.toThrow(quotaError)

    expect(mockReportQuotaExceeded).toHaveBeenCalled()
    setItemSpy.mockRestore()
  })

  it('re-throws errors during migration and allows retrying on next call without stale caching', async () => {
    const metaStorage = getSyncMetadataStorage(accountId)
    const getItemSpy = vi.spyOn(metaStorage, 'getItem').mockRejectedValueOnce(new Error('Migration read failed'))
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    resetMigrationForTesting()

    // First attempt fails and rejects
    await expect(readManualRecoveryEntries(accountId)).rejects.toThrow('Migration read failed')
    expect(consoleErrorSpy).toHaveBeenCalledWith('[ManualRecoveryStore] Migration failed', expect.any(Error))

    getItemSpy.mockRestore()

    // Second attempt should retry migration rather than using cached failure/resolution
    await expect(readManualRecoveryEntries(accountId)).resolves.toEqual([])

    consoleErrorSpy.mockRestore()
  })
})
