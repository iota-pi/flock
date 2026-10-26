import { LastModifiedStore, type ItemSyncTimestamps } from './LastModifiedStore'
import {
  SYNC_METADATA_KEYS,
} from './syncMetadataStorage'
import type { ItemId } from '@vault/shared'

import { createMockLocalForagePool } from '../__test__/testUtils'
import { clearAccountStoreInstancesCacheForTesting } from '../../shared/createAccountStore'

const pool = createMockLocalForagePool()
const instances = pool.instances

vi.mock('localforage', () => ({
  default: {
    createInstance: vi.fn().mockImplementation((config: Record<string, any>) => {
      return pool.createInstance(config)
    }),
  },
}))

vi.mock('../../utils/storageManager', () => ({
  runStorageOperation: vi.fn(async (op: () => Promise<any>) => op()),
}))

describe('LastModifiedStore', () => {
  let store: LastModifiedStore
  const accountId = 'account-1'

  beforeEach(() => {
    vi.clearAllMocks()
    instances.clear()
    clearAccountStoreInstancesCacheForTesting()
    store = new LastModifiedStore(accountId)
  })

  it('saves and loads dual timestamps correctly in consolidated store', async () => {
    const input: [ItemId, ItemSyncTimestamps][] = [
      ['item-1' as ItemId, { localModifiedAt: 2000, lastSnapshotAt: 1000 }],
      ['item-2' as ItemId, { localModifiedAt: 3000 }],
    ]

    await store.saveTimestamps(input)
    const loaded = await store.loadTimestamps()

    expect(loaded).toEqual([
      ['item-1', { localModifiedAt: 2000, lastSnapshotAt: 1000, baseVersion: 0 }],
      ['item-2', { localModifiedAt: 3000, lastSnapshotAt: undefined, baseVersion: 0 }],
    ])

    const consolidatedStore = instances.get(`test-vault-sync-metadata-${accountId}#sync-metadata`)
    expect(await consolidatedStore?.getItem(SYNC_METADATA_KEYS.LAST_MODIFIED)).toEqual(input)
  })


  it('returns null when storage is empty', async () => {
    const timestamps = await store.loadTimestamps()
    expect(timestamps).toBeNull()
  })

  it('clears storage key without clearing entire consolidated database', async () => {
    const consolidatedStore = instances.get(`test-vault-sync-metadata-${accountId}#sync-metadata`)
    await consolidatedStore?.setItem(SYNC_METADATA_KEYS.CURSORS, [['item-1', 10]])

    await store.saveTimestamps([['item-1' as ItemId, { localModifiedAt: 100 }]])
    await store.clear()

    const loaded = await store.loadTimestamps()
    expect(loaded).toBeNull()

    // Cursors should still exist
    expect(await consolidatedStore?.getItem(SYNC_METADATA_KEYS.CURSORS)).toEqual([['item-1', 10]])
  })


})
