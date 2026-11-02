import { SyncedHeadsStore } from './SyncedHeadsStore'
import {
  SYNC_METADATA_KEYS,
} from './syncMetadataStorage'
import type { DocumentId } from '@automerge/automerge-repo/slim'

import { createMockLocalForagePool, mockLocalForage } from '../__test__/testUtils'
import { clearAccountStoreInstancesCacheForTesting } from '../../shared/createAccountStore'

const pool = createMockLocalForagePool()
const instances = pool.instances

describe('SyncedHeadsStore', () => {
  let store: SyncedHeadsStore
  const accountId = 'account-1'

  beforeEach(() => {
    vi.clearAllMocks()
    mockLocalForage(pool.createInstance)
    instances.clear()
    clearAccountStoreInstancesCacheForTesting()
    store = new SyncedHeadsStore(accountId)
  })

  it('saves and loads synced heads correctly using consolidated key', async () => {
    const input: [DocumentId, string[]][] = [
      ['doc-1' as DocumentId, ['head-1a', 'head-1b']],
      ['doc-2' as DocumentId, ['head-2a']],
    ]

    await store.saveSyncedHeads(input)
    const loaded = await store.loadSyncedHeads()

    expect(loaded).toEqual([
      ['doc-1', ['head-1a', 'head-1b']],
      ['doc-2', ['head-2a']],
    ])

    const consolidatedStore = instances.get(`test-vault-sync-metadata-${accountId}#sync-metadata`)
    expect(await consolidatedStore?.getItem(SYNC_METADATA_KEYS.SYNCED_HEADS)).toEqual(input)
  })

  it('returns null when storage is empty', async () => {
    const loaded = await store.loadSyncedHeads()
    expect(loaded).toBeNull()
  })

  it('clears storage key without clearing entire consolidated database', async () => {
    const consolidatedStore = instances.get(`test-vault-sync-metadata-${accountId}#sync-metadata`)
    await consolidatedStore?.setItem(SYNC_METADATA_KEYS.CURSORS, [['item-1', 10]])

    await store.saveSyncedHeads([['doc-1' as DocumentId, ['head-1']]])
    await store.clear()

    const loaded = await store.loadSyncedHeads()
    expect(loaded).toBeNull()

    // Cursors should still exist
    expect(await consolidatedStore?.getItem(SYNC_METADATA_KEYS.CURSORS)).toEqual([['item-1', 10]])
  })

  it('handles invalid data format gracefully', async () => {
    const consolidatedStore = instances.get(`test-vault-sync-metadata-${accountId}#sync-metadata`)
    await consolidatedStore?.setItem(SYNC_METADATA_KEYS.SYNCED_HEADS, 'corrupted-data')
    const loaded = await store.loadSyncedHeads()
    expect(loaded).toBeNull()
  })

})
