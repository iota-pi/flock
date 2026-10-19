import {
  deferMigration,
  hasLegacyLocalData,
  isMigrationDeferred,
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
    expect(await hasLegacyLocalData('acct-1')).toBe(true)
  })

  it.each(['flock-automerge-db-acct-1', 'FlockVault_SyncWAL_acct-1'])('finds the account\'s plaintext database %s', async name => {
    ;(globalThis as any).indexedDB = { databases: vi.fn().mockResolvedValue([{ name }]) }
    expect(await hasLegacyLocalData('acct-1')).toBe(true)
  })

  it('ignores another account\'s plaintext databases', async () => {
    ;(globalThis as any).indexedDB = { databases: vi.fn().mockResolvedValue([{ name: 'flock-automerge-db-acct-2' }]) }
    expect(await hasLegacyLocalData('acct-1')).toBe(false)
  })

  it('is false without them', async () => {
    ;(globalThis as any).indexedDB = { databases: vi.fn().mockResolvedValue([{ name: 'other' }]) }
    expect(await hasLegacyLocalData('acct-1')).toBe(false)
  })
})
