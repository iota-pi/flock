import { LastSyncedStore } from './LastSyncedStore'
import { SYNC_METADATA_KEYS } from './syncMetadataStorage'
import { createMockLocalForagePool, mockLocalForage } from '../__test__/testUtils'
import { clearAccountStoreInstancesCacheForTesting } from '../../shared/createAccountStore'

const pool = createMockLocalForagePool()

describe('LastSyncedStore', () => {
  const accountId = 'account-1'
  let store: LastSyncedStore

  beforeEach(() => {
    mockLocalForage(pool.createInstance)
    pool.instances.clear()
    clearAccountStoreInstancesCacheForTesting()
    store = new LastSyncedStore(accountId)
  })

  it('loads null before anything is saved', async () => {
    expect(await store.load()).toBeNull()
  })

  it('saves and loads the timestamp', async () => {
    await store.save(12345)
    expect(await store.load()).toBe(12345)
  })

  it('treats a stored value that is not a number as missing', async () => {
    const consolidated = pool.instances.get(`test-vault-sync-metadata-${accountId}#sync-metadata`)!
    await consolidated.setItem(SYNC_METADATA_KEYS.LAST_SYNCED_AT, 'yesterday')
    expect(await store.load()).toBeNull()
  })
})
