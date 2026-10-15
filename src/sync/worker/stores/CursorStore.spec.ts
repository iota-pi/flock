import { CursorStore } from './CursorStore'
import {
  clearSyncMetadataInstancesCacheForTesting,
  SYNC_METADATA_KEYS,
} from './syncMetadataStorage'
import type { ItemId } from 'src/shared/vault/ids'

import { createMockLocalForagePool } from '../__test__/testUtils'

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

describe('CursorStore', () => {
  let store: CursorStore
  const accountId = 'account-1'

  beforeEach(() => {
    vi.clearAllMocks()
    instances.clear()
    clearSyncMetadataInstancesCacheForTesting()
    store = new CursorStore(accountId)
  })

  it('saves and loads cursors correctly using consolidated key', async () => {
    const state = {
      globalCursor: 200,
      retries: [['item-1' as ItemId, 100]] as [ItemId, number][],
    }

    await store.saveCursors(state)
    const loaded = await store.loadCursors()
    expect(loaded).toEqual(state)

    // Verify key in consolidated store
    const consolidatedStore = instances.get(`flock-sync-metadata-${accountId}#sync-metadata`)
    expect(await consolidatedStore?.getItem(SYNC_METADATA_KEYS.CURSORS)).toEqual(state)
  })

  it('clears cursors without clearing entire database', async () => {
    const consolidatedStore = instances.get(`flock-sync-metadata-${accountId}#sync-metadata`)
    await consolidatedStore?.setItem(SYNC_METADATA_KEYS.INDEX_DOC, { itemIds: ['other'] })

    await store.saveCursors({ globalCursor: 100 })
    await store.clear()

    const loaded = await store.loadCursors()
    expect(loaded).toBeNull()

    // Index doc should remain intact!
    expect(await consolidatedStore?.getItem(SYNC_METADATA_KEYS.INDEX_DOC)).toEqual({ itemIds: ['other'] })
  })


})

