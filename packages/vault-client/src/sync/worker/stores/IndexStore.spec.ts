import { IndexStore } from './IndexStore'
import {
  SYNC_METADATA_KEYS,
} from './syncMetadataStorage'
import type { AutomergeIndexDocument } from '../docStore/AutomergeDocStore'

import { createMockLocalForagePool, createTestLocalCipher } from '../__test__/testUtils'
import { LocalDataUnreadableError } from '../localEncryption/LocalCipher'
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

describe('IndexStore', () => {
  let store: IndexStore
  const accountId = 'account-1'

  beforeEach(() => {
    vi.clearAllMocks()
    instances.clear()
    clearAccountStoreInstancesCacheForTesting()
    store = new IndexStore(accountId)
  })

  it('saves and loads index document correctly in consolidated store', async () => {
    const doc = { itemIds: ['item-1', 'item-2'] } as unknown as AutomergeIndexDocument
    await store.saveIndex(doc)
    const loaded = await store.getIndex()
    expect(loaded).toEqual(doc)

    const consolidatedStore = instances.get(`test-vault-sync-metadata-${accountId}#sync-metadata`)
    expect(await consolidatedStore?.getItem(SYNC_METADATA_KEYS.INDEX_DOC)).toEqual(doc)
  })

  it('clears index document without affecting other keys', async () => {
    const consolidatedStore = instances.get(`test-vault-sync-metadata-${accountId}#sync-metadata`)
    await consolidatedStore?.setItem(SYNC_METADATA_KEYS.CURSORS, [['item-1', 1]])

    const doc = { itemIds: ['item-1'] } as unknown as AutomergeIndexDocument
    await store.saveIndex(doc)
    await store.clear()

    const loaded = await store.getIndex()
    expect(loaded).toBeNull()

    // Cursors should still exist
    expect(await consolidatedStore?.getItem(SYNC_METADATA_KEYS.CURSORS)).toEqual([['item-1', 1]])
  })

  describe('sealed', () => {
    const doc = {
      accountId,
      itemIds: ['item-1'],
      tombstoneIds: ['item-0'],
      metadata: { sortCriteria: ['name'] },
    } as unknown as AutomergeIndexDocument

    function metadataStore() {
      return Array.from(instances.values()).find(instance => instance.data.size > 0)
    }

    it('stores the index sealed under its own key', async () => {
      const sealedStore = new IndexStore(accountId, { cipher: await createTestLocalCipher(accountId) })

      await sealedStore.saveIndex(doc)

      expect(await sealedStore.getIndex()).toEqual(doc)
      const stored = metadataStore()!
      expect(stored.data.has(SYNC_METADATA_KEYS.INDEX_DOC)).toBe(false)
      const sealed = stored.data.get(SYNC_METADATA_KEYS.INDEX_DOC_SEALED)
      expect(sealed.v).toBe(1)
      expect(new TextDecoder().decode(sealed.ct)).not.toContain('item-1')
    })

    it('ignores the plaintext index', async () => {
      await store.saveIndex(doc)
      const sealedStore = new IndexStore(accountId, { cipher: await createTestLocalCipher(accountId) })

      expect(await sealedStore.getIndex()).toBeNull()
    })

    it('throws when the sealed index cannot be opened, rather than reporting no index', async () => {
      await new IndexStore(accountId, { cipher: await createTestLocalCipher(accountId) }).saveIndex(doc)
      const otherKey = new IndexStore(accountId, { cipher: await createTestLocalCipher(accountId) })

      await expect(otherKey.getIndex()).rejects.toBeInstanceOf(LocalDataUnreadableError)
    })

    it('reports an index in either layout without decrypting it', async () => {
      expect(await store.hasIndex()).toBe(false)

      await new IndexStore(accountId, { cipher: await createTestLocalCipher(accountId) }).saveIndex(doc)
      expect(await store.hasIndex()).toBe(true)

      await store.clear()
      await new IndexStore(accountId, { cipher: await createTestLocalCipher(accountId) }).clear()
      await store.saveIndex(doc)
      expect(await store.hasIndex()).toBe(true)
    })
  })
})
