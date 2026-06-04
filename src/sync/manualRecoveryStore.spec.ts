import localforage from 'localforage'
import {
  clearManualRecoveryEntries,
  readManualRecoveryCount,
  readManualRecoveryEntries,
  removeManualRecoveryEntryById,
  removeManualRecoveryEntryByItemId,
  resetMigrationForTesting,
  upsertManualRecoveryEntry,
} from './manualRecoveryStore'


describe('manualRecoveryStore', () => {
  beforeEach(async () => {
    await clearManualRecoveryEntries()
    // Also clean up metadata store
    const metaStorage = localforage.createInstance({
      name: 'FlockVault_ManualRecoveryDB',
      storeName: 'manual-recovery-metadata',
    })
    await metaStorage.clear()
    resetMigrationForTesting()
  })

  it('upserts entries by item id and updates count', async () => {
    await upsertManualRecoveryEntry({ itemId: 'item-1', reason: 'first failure' })
    await upsertManualRecoveryEntry({ itemId: 'item-1', reason: 'second failure' })

    const entries = await readManualRecoveryEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0].itemId).toBe('item-1')
    expect(entries[0].reason).toBe('second failure')
    expect(await readManualRecoveryCount()).toBe(1)
  })

  it('removes entries by id and by item id', async () => {
    const first = await upsertManualRecoveryEntry({ itemId: 'item-1', reason: 'failed' })
    await upsertManualRecoveryEntry({ itemId: 'item-2', reason: 'failed' })

    await removeManualRecoveryEntryById(first.id)
    expect(await readManualRecoveryCount()).toBe(1)

    await removeManualRecoveryEntryByItemId('item-2')
    expect(await readManualRecoveryCount()).toBe(0)
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
      name: 'FlockVault_ManualRecoveryDB',
      storeName: 'manual-recovery-items',
    })
    const metaStorage = localforage.createInstance({
      name: 'FlockVault_ManualRecoveryDB',
      storeName: 'manual-recovery-metadata',
    })

    // Write a legacy entry directly to bypass ensureMigrated
    await legacyStorage.setItem(legacyKey, legacyEntry)
    // Clear migration flag and reset cached promise
    await metaStorage.removeItem('__migrated_v2')
    resetMigrationForTesting()

    // Trigger migration by doing an operation
    const entries = await readManualRecoveryEntries()

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
    await readManualRecoveryEntries()
    const notMigratedVal = await legacyStorage.getItem('legacy-item-2')
    expect(notMigratedVal).toBeNull()
    const stillLegacyVal = await legacyStorage.getItem('uuid-2')
    expect(stillLegacyVal).not.toBeNull()
  })
})
