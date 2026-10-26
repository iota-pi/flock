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
vi.mock('../utils/storageManager', () => ({
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

let clearAccountStoreInstancesCacheForTesting: any
let clearManualRecoveryEntries: any
let readManualRecoveryCount: any
let readManualRecoveryEntries: any
let removeManualRecoveryEntryById: any
let removeManualRecoveryEntryByItemId: any
let upsertManualRecoveryEntry: any
let removeManualRecoveryEntryIfKind: any

describe('manualRecoveryStore', () => {
  const accountId = 'test-account-id'

  beforeAll(async () => {
    clearAccountStoreInstancesCacheForTesting = (await import('./createAccountStore')).clearAccountStoreInstancesCacheForTesting
    const mod = await import('./manualRecoveryStore')
    clearManualRecoveryEntries = mod.clearManualRecoveryEntries
    readManualRecoveryCount = mod.readManualRecoveryCount
    readManualRecoveryEntries = mod.readManualRecoveryEntries
    removeManualRecoveryEntryById = mod.removeManualRecoveryEntryById
    removeManualRecoveryEntryByItemId = mod.removeManualRecoveryEntryByItemId
    upsertManualRecoveryEntry = mod.upsertManualRecoveryEntry
    removeManualRecoveryEntryIfKind = mod.removeManualRecoveryEntryIfKind
  })
  beforeEach(async () => {
    createdInstances.length = 0
    clearAccountStoreInstancesCacheForTesting()
    await clearManualRecoveryEntries(accountId)
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
      const storage = localforage.createInstance({
        name: 'test-vault-manual-recovery-test-account-id',
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
    const storage = createdInstances.find(i => i.config?.().name === 'test-vault-manual-recovery-test-account-id' && i.config?.().storeName === 'manual-recovery-items')
    const setItemSpy = vi.spyOn(storage, 'setItem').mockRejectedValueOnce(quotaError)

    await expect(
      upsertManualRecoveryEntry(accountId, { itemId: 'item-quota', reason: 'quota', kind: 'unknown' })
    ).rejects.toThrow(quotaError)

    expect(mockReportQuotaExceeded).toHaveBeenCalled()
    setItemSpy.mockRestore()
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

