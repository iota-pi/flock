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
let removeManualRecoveryEntryIfKind: any

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
    removeManualRecoveryEntryIfKind = mod.removeManualRecoveryEntryIfKind
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
    await upsertManualRecoveryEntry(accountId, { itemId: 'item-1', reason: 'first failure', kind: 'unknown' })
    await upsertManualRecoveryEntry(accountId, { itemId: 'item-1', reason: 'second failure', kind: 'unknown' })

    const entries = await readManualRecoveryEntries(accountId)
    expect(entries).toHaveLength(1)
    expect(entries[0].itemId).toBe('item-1')
    expect(entries[0].reason).toBe('second failure')
    expect(await readManualRecoveryCount(accountId)).toBe(1)
  })

  it('persists kind on upsert and returns it on read', async () => {
    await upsertManualRecoveryEntry(accountId, { itemId: 'item-1', reason: 'too big', kind: 'oversized' })

    const entries = await readManualRecoveryEntries(accountId)
    expect(entries[0].kind).toBe('oversized')
  })

  describe('legacy kind inference', () => {
    const cases: Array<[string, string, string?]> = [
      ['Snapshot size (400 KB) exceeds 350 KB limit. Recreating the item.', 'oversized'],
      ['Push failed after 5 consecutive attempts: Rate limit exceeded', 'pushFailure'],
      ['Snapshot failure: x', 'snapshotFailure'],
      ['Re-encryption upload failed: x', 'snapshotFailure'],
      ['Automated recovery is unavailable for this revision', 'pullDecryption'],
      ['Corrupted branches: a', 'pullDecryption'],
      ['something else', 'unknown'],
      ['something else', 'unknown', 'bogus'],
    ]

    it.each(cases)('infers kind for %j as %s', async (reason, expected, storedKind) => {
      // Ensure migration has run so the raw write below is not rewritten
      await readManualRecoveryEntries(accountId)
      const storage = localforage.createInstance({
        name: 'FlockVault_ManualRecoveryDB_test-account-id',
        storeName: 'manual-recovery-items',
      })
      await storage.setItem('item-legacy', {
        id: 'item-legacy',
        itemId: 'item-legacy',
        reason,
        createdAt: 1,
        ...(storedKind ? { kind: storedKind } : {}),
      })

      const entries = await readManualRecoveryEntries(accountId)
      expect(entries).toHaveLength(1)
      expect(entries[0].kind).toBe(expected)
    })
  })

  describe('upsert precedence', () => {
    it.each([
      ['pullDecryption'],
      ['pushFailure'],
      ['snapshotFailure'],
    ])('does not replace an oversized entry with %s', async weaker => {
      const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(1000)
      const first = await upsertManualRecoveryEntry(accountId, { itemId: 'item-1', reason: 'too big', kind: 'oversized' })
      dateSpy.mockReturnValue(2000)

      const result = await upsertManualRecoveryEntry(accountId, { itemId: 'item-1', reason: 'weaker', kind: weaker })
      dateSpy.mockRestore()

      expect(result).toEqual(first)
      const entries = await readManualRecoveryEntries(accountId)
      expect(entries[0]).toEqual(expect.objectContaining({ kind: 'oversized', reason: 'too big', createdAt: 1000 }))
    })

    it('replaces pullDecryption with pushFailure', async () => {
      await upsertManualRecoveryEntry(accountId, { itemId: 'item-1', reason: 'decrypt', kind: 'pullDecryption' })
      await upsertManualRecoveryEntry(accountId, { itemId: 'item-1', reason: 'push', kind: 'pushFailure' })

      const entries = await readManualRecoveryEntries(accountId)
      expect(entries[0]).toEqual(expect.objectContaining({ kind: 'pushFailure', reason: 'push' }))
    })

    it('replaces pushFailure with snapshotFailure', async () => {
      await upsertManualRecoveryEntry(accountId, { itemId: 'item-1', reason: 'push', kind: 'pushFailure' })
      await upsertManualRecoveryEntry(accountId, { itemId: 'item-1', reason: 'snap', kind: 'snapshotFailure' })

      const entries = await readManualRecoveryEntries(accountId)
      expect(entries[0]).toEqual(expect.objectContaining({ kind: 'snapshotFailure', reason: 'snap' }))
    })

    it('refreshes an oversized entry with a new oversized quarantine', async () => {
      await upsertManualRecoveryEntry(accountId, { itemId: 'item-1', reason: 'old', kind: 'oversized' })
      await upsertManualRecoveryEntry(accountId, { itemId: 'item-1', reason: 'new', kind: 'oversized' })

      const entries = await readManualRecoveryEntries(accountId)
      expect(entries[0]).toEqual(expect.objectContaining({ kind: 'oversized', reason: 'new' }))
    })
  })

  describe('removeManualRecoveryEntryIfKind', () => {
    it('removes an entry with a matching kind', async () => {
      await upsertManualRecoveryEntry(accountId, { itemId: 'item-1', reason: 'decrypt', kind: 'pullDecryption' })

      expect(await removeManualRecoveryEntryIfKind(accountId, 'item-1', new Set(['pullDecryption']))).toBe(true)
      expect(await readManualRecoveryCount(accountId)).toBe(0)
    })

    it('keeps an entry with a non-matching kind', async () => {
      await upsertManualRecoveryEntry(accountId, { itemId: 'item-1', reason: 'big', kind: 'oversized' })

      expect(await removeManualRecoveryEntryIfKind(accountId, 'item-1', new Set(['pullDecryption']))).toBe(false)
      expect(await readManualRecoveryCount(accountId)).toBe(1)
    })

    it('returns false for a missing entry', async () => {
      expect(await removeManualRecoveryEntryIfKind(accountId, 'missing', new Set(['pullDecryption']))).toBe(false)
    })

    it('serializes with concurrent upserts so an oversized quarantine is never lost', async () => {
      for (const upsertFirst of [true, false]) {
        await clearManualRecoveryEntries(accountId)
        await upsertManualRecoveryEntry(accountId, { itemId: 'item-1', reason: 'decrypt', kind: 'pullDecryption' })

        const upsert = () => upsertManualRecoveryEntry(accountId, { itemId: 'item-1', reason: 'big', kind: 'oversized' })
        const remove = () => removeManualRecoveryEntryIfKind(accountId, 'item-1', new Set(['pullDecryption']))
        await (upsertFirst ? Promise.all([upsert(), remove()]) : Promise.all([remove(), upsert()]))

        const entries = await readManualRecoveryEntries(accountId)
        expect(entries).toHaveLength(1)
        expect(entries[0].kind).toBe('oversized')
      }
    })
  })

  it('removes entries by id and by item id', async () => {
    const first = await upsertManualRecoveryEntry(accountId, { itemId: 'item-1', reason: 'failed', kind: 'unknown' })
    await upsertManualRecoveryEntry(accountId, { itemId: 'item-2', reason: 'failed', kind: 'unknown' })

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
    await upsertManualRecoveryEntry(accountId, { itemId: 'item-b', reason: 'error-b', kind: 'unknown' })

    dateSpy.mockReturnValueOnce(now)
    await upsertManualRecoveryEntry(accountId, { itemId: 'item-c', reason: 'error-c', kind: 'unknown' })

    dateSpy.mockReturnValueOnce(now - 1000)
    await upsertManualRecoveryEntry(accountId, { itemId: 'item-a', reason: 'error-a', kind: 'unknown' })

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
      upsertManualRecoveryEntry(accountId, { itemId: 'item-quota', reason: 'quota', kind: 'unknown' })
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

  it('paginates manual recovery entries with limit and offset', async () => {
    const baseTime = Date.now()
    const dateSpy = vi.spyOn(Date, 'now')

    for (let i = 1; i <= 5; i++) {
      dateSpy.mockReturnValueOnce(baseTime + i * 1000)
      await upsertManualRecoveryEntry(accountId, { itemId: `item-${i}`, reason: `error-${i}`, kind: 'unknown' })
    }

    // Page 1: limit 2, offset 0 -> newest items: item-5, item-4
    const page1 = await readManualRecoveryEntries(accountId, { limit: 2, offset: 0 })
    expect(page1).toHaveLength(2)
    expect(page1[0].itemId).toBe('item-5')
    expect(page1[1].itemId).toBe('item-4')

    // Page 2: limit 2, offset 2 -> next items: item-3, item-2
    const page2 = await readManualRecoveryEntries(accountId, { limit: 2, offset: 2 })
    expect(page2).toHaveLength(2)
    expect(page2[0].itemId).toBe('item-3')
    expect(page2[1].itemId).toBe('item-2')

    // Page 3: limit 2, offset 4 -> last item: item-1
    const page3 = await readManualRecoveryEntries(accountId, { limit: 2, offset: 4 })
    expect(page3).toHaveLength(1)
    expect(page3[0].itemId).toBe('item-1')

    // Past end: offset 5 -> empty
    const page4 = await readManualRecoveryEntries(accountId, { limit: 2, offset: 5 })
    expect(page4).toEqual([])

    dateSpy.mockRestore()
  })

  it('caps limit at MAX_MANUAL_RECOVERY_LIMIT', async () => {
    const mod = await import('./manualRecoveryStore')
    expect(mod.MAX_MANUAL_RECOVERY_LIMIT).toBe(500)
    expect(mod.DEFAULT_MANUAL_RECOVERY_LIMIT).toBe(100)

    await upsertManualRecoveryEntry(accountId, { itemId: 'item-1', reason: 'err', kind: 'unknown' })
    const entries = await readManualRecoveryEntries(accountId, { limit: 9999 })
    expect(entries).toHaveLength(1)
  })
})

