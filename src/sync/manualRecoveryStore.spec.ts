import {
  clearManualRecoveryEntries,
  readManualRecoveryCount,
  readManualRecoveryEntries,
  removeManualRecoveryEntryById,
  removeManualRecoveryEntryByItemId,
  upsertManualRecoveryEntry,
} from './manualRecoveryStore'


describe('manualRecoveryStore', () => {
  beforeEach(async () => {
    await clearManualRecoveryEntries()
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
})
