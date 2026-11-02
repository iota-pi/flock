import type { MockInstance } from 'vitest'
import { getVaultStorageNames } from '../../shared/storageNames'
import { getAccountDatabaseName, clearAccountStoreInstancesCacheForTesting } from '../../shared/createAccountStore'
import { getAutomergeDBName } from '../AutomergeRepoManager'
import { getSyncMetadataStorage, SYNC_METADATA_KEYS } from '../stores/syncMetadataStorage'
import * as deleteDatabaseModule from '../../utils/deleteDatabase'
import { createMockLocalForagePool, mockLocalForage } from '../__test__/testUtils'
import { retireLegacyStores } from './retireLegacyStores'

const pool = createMockLocalForagePool()

const ACCOUNT = 'account-1'

describe('retireLegacyStores', () => {
  let locks: { held: { name: string }[], pending: { name: string }[] }
  let deleteDatabase: MockInstance<typeof deleteDatabaseModule.deleteDatabase>

  beforeEach(async () => {
    mockLocalForage(pool.createInstance)
    pool.clear()
    clearAccountStoreInstancesCacheForTesting()
    deleteDatabase = vi.spyOn(deleteDatabaseModule, 'deleteDatabase').mockResolvedValue(undefined)
    locks = { held: [], pending: [] }
    vi.stubGlobal('navigator', { locks: { query: vi.fn(async () => locks) } })
    await getSyncMetadataStorage(ACCOUNT).setItem(SYNC_METADATA_KEYS.INDEX_DOC, { itemIds: [] })
    await getSyncMetadataStorage(ACCOUNT).setItem(SYNC_METADATA_KEYS.CURSORS, [])
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function leaderLock(): { name: string } {
    return { name: `${getVaultStorageNames().accountPrefixes.leaderLock}${ACCOUNT}` }
  }

  async function expectRetired(): Promise<void> {
    expect(deleteDatabase).toHaveBeenCalledWith(getAutomergeDBName(ACCOUNT), expect.any(Number))
    expect(deleteDatabase).toHaveBeenCalledWith(getAccountDatabaseName('wal-entries', ACCOUNT), expect.any(Number))
    expect(await getSyncMetadataStorage(ACCOUNT).getItem(SYNC_METADATA_KEYS.INDEX_DOC)).toBeNull()
    expect(await getSyncMetadataStorage(ACCOUNT).getItem(SYNC_METADATA_KEYS.CURSORS)).toEqual([])
  }

  it('deletes the plaintext stores straight away when nothing else is using the account', async () => {
    const onRetiring = vi.fn()

    expect(await retireLegacyStores({ accountId: ACCOUNT, onRetiring })).toBe(true)

    expect(onRetiring).not.toHaveBeenCalled()
    await expectRetired()
  })

  it('ignores other accounts\' locks', async () => {
    locks.held.push({ name: `${getVaultStorageNames().accountPrefixes.leaderLock}account-2` })

    expect(await retireLegacyStores({ accountId: ACCOUNT })).toBe(true)
  })

  it('asks other tabs to stop, then deletes once they let go', async () => {
    locks.held.push(leaderLock())
    const onRetiring = vi.fn(() => {
      locks.held = []
    })

    expect(await retireLegacyStores({ accountId: ACCOUNT, onRetiring, pollMs: 1 })).toBe(true)

    expect(onRetiring).toHaveBeenCalledTimes(1)
    await expectRetired()
  })

  it.each(['held', 'pending'] as const)('leaves everything for the next start while another tab still has the lock %s', async state => {
    locks[state].push(leaderLock())
    const onRetiring = vi.fn()

    expect(await retireLegacyStores({ accountId: ACCOUNT, onRetiring, waitMs: 5, pollMs: 1 })).toBe(false)

    expect(onRetiring).toHaveBeenCalledTimes(1)
    expect(deleteDatabase).not.toHaveBeenCalled()
    expect(await getSyncMetadataStorage(ACCOUNT).getItem(SYNC_METADATA_KEYS.INDEX_DOC)).not.toBeNull()
  })

  it('also waits for the index lock', async () => {
    locks.held.push({ name: `${getVaultStorageNames().accountPrefixes.indexLock}${ACCOUNT}` })

    expect(await retireLegacyStores({ accountId: ACCOUNT, waitMs: 5, pollMs: 1 })).toBe(false)
  })

  it('keeps the plaintext index when a database deletion is blocked', async () => {
    deleteDatabase.mockRejectedValueOnce(new Error('blocked'))

    expect(await retireLegacyStores({ accountId: ACCOUNT })).toBe(false)

    expect(await getSyncMetadataStorage(ACCOUNT).getItem(SYNC_METADATA_KEYS.INDEX_DOC)).not.toBeNull()
  })

  it('does nothing without Web Locks, since it can\'t tell whether another tab is using the stores', async () => {
    vi.stubGlobal('navigator', {})

    expect(await retireLegacyStores({ accountId: ACCOUNT })).toBe(false)
    expect(deleteDatabase).not.toHaveBeenCalled()
  })
})
