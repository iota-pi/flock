import localforage from 'localforage'

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
    // Also clean up metadata store
    const metaStorage = localforage.createInstance({
      name: 'FlockVault_ManualRecoveryDB_test-account-id',
      storeName: 'manual-recovery-metadata',
    })
    await metaStorage.clear()
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
      name: 'FlockVault_ManualRecoveryDB_test-account-id',
      storeName: 'manual-recovery-metadata',
    })

    // Write a legacy entry directly to bypass ensureMigrated
    await legacyStorage.setItem(legacyKey, legacyEntry)
    // Clear migration flag and reset cached promise
    await metaStorage.removeItem('__migrated_v2')
    resetMigrationForTesting()

    // Trigger migration by doing an operation
    const entries = await readManualRecoveryEntries(accountId)

    // Assert migration happened
    expect(entries).toHaveLength(1)
    expect(entries[0].id).toBe('legacy-item-id')
    expect(entries[0].itemId).toBe('legacy-item-id')

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

  it('contains errors thrown during migration runMigration', async () => {
    const metaStorage = createdInstances.find(i => i.config?.().name === 'FlockVault_ManualRecoveryDB_test-account-id' && i.config?.().storeName === 'manual-recovery-metadata')
    const getItemSpy = vi.spyOn(metaStorage, 'getItem').mockRejectedValueOnce(new Error('Migration read failed'))
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    resetMigrationForTesting()

    await expect(readManualRecoveryEntries(accountId)).resolves.toBeDefined()
    expect(consoleErrorSpy).toHaveBeenCalledWith('[ManualRecoveryStore] Migration failed', expect.any(Error))

    getItemSpy.mockRestore()
    consoleErrorSpy.mockRestore()
  })
})
