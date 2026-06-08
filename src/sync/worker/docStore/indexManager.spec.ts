import { Repo } from '@automerge/automerge-repo/slim'
import * as Automerge from '@automerge/automerge/slim'
import { AutomergeDocStore, type AutomergeIndexDocument } from './AutomergeDocStore'
import { ItemId } from '../../../shared/schemas/items'

const testRepo = new Repo()

vi.mock('../automergeRepo', () => {
  return {
    getAutomergeRepo: () => testRepo,
    getAutomergeDBName: () => 'flock-automerge-test-db',
    closeAutomergeRepo: vi.fn(),
  }
})

describe('indexManager', () => {
  const accountId = 'test-account-id'
  let docStore: AutomergeDocStore

  beforeEach(async () => {
    docStore = new AutomergeDocStore(accountId, testRepo)
    await docStore.clear()
    await docStore.initialize()
  })

  describe('Basic Add and Remove Operations', () => {
    it('should add item IDs to the index correctly', async () => {
      await docStore.addAutomergeItemIdsToIndex(['item-1', 'item-2'] as ItemId[])
      const itemIds = await docStore.listAutomergeItemIds()
      expect(itemIds).toEqual(['item-1', 'item-2'])
    })

    it('should deduplicate item IDs upon insertion', async () => {
      await docStore.addAutomergeItemIdsToIndex(['item-1', 'item-2'] as ItemId[])
      await docStore.addAutomergeItemIdsToIndex(['item-2', 'item-3'] as ItemId[])
      const itemIds = await docStore.listAutomergeItemIds()
      expect(itemIds).toEqual(['item-1', 'item-2', 'item-3'])
    })

    it('should remove item IDs from the index correctly', async () => {
      await docStore.addAutomergeItemIdsToIndex(['item-1', 'item-2', 'item-3'] as ItemId[])
      await docStore.removeAutomergeItemIdsFromIndex(['item-2'] as ItemId[])
      const itemIds = await docStore.listAutomergeItemIds()
      expect(itemIds).toEqual(['item-1', 'item-3'])
    })

    it('should handle removing non-existent item IDs gracefully', async () => {
      await docStore.addAutomergeItemIdsToIndex(['item-1'] as ItemId[])
      await docStore.removeAutomergeItemIdsFromIndex(['non-existent'] as ItemId[])
      const itemIds = await docStore.listAutomergeItemIds()
      expect(itemIds).toEqual(['item-1'])
    })
  })

  describe('Concurrent Offline Edits and Conflict Resolution (CRDT Merge Proof)', () => {
    it('PROVES OLD BEHAVIOR FAILED: full array reassignments lead to data loss on concurrent merge', () => {
      const baseDoc = Automerge.from<AutomergeIndexDocument>({
        itemIds: ['item-base'] as ItemId[],
      })

      const docA = Automerge.change<AutomergeIndexDocument>(Automerge.clone(baseDoc), doc => {
        doc.itemIds = ['item-base', 'item-a'] as ItemId[]
      })

      const docB = Automerge.change<AutomergeIndexDocument>(Automerge.clone(baseDoc), doc => {
        doc.itemIds = ['item-base', 'item-b'] as ItemId[]
      })

      const merged = Automerge.merge(docA, docB)

      expect(merged.itemIds?.length).toBe(2)
      const hasA = merged.itemIds?.includes('item-a' as ItemId)
      const hasB = merged.itemIds?.includes('item-b' as ItemId)
      expect(hasA !== hasB).toBe(true)
    })

    it('PROVES FIX WORKS: push-based in-place mutations correctly merge concurrent offline additions', () => {
      const baseDoc = Automerge.from<AutomergeIndexDocument>({
        itemIds: ['item-base'] as ItemId[],
      })

      const docA = Automerge.change<AutomergeIndexDocument>(Automerge.clone(baseDoc), doc => {
        if (!doc.itemIds) doc.itemIds = []
        const current = new Set(doc.itemIds)
        if (!current.has('item-a' as ItemId)) {
          doc.itemIds.push('item-a' as ItemId)
        }
      })

      const docB = Automerge.change<AutomergeIndexDocument>(Automerge.clone(baseDoc), doc => {
        if (!doc.itemIds) doc.itemIds = []
        const current = new Set(doc.itemIds)
        if (!current.has('item-b' as ItemId)) {
          doc.itemIds.push('item-b' as ItemId)
        }
      })

      const merged = Automerge.merge(docA, docB)

      expect(merged.itemIds).toContain('item-base')
      expect(merged.itemIds).toContain('item-a')
      expect(merged.itemIds).toContain('item-b')
      expect(merged.itemIds?.length).toBe(3)
    })

    it('PROVES FIX WORKS: splice-based in-place mutations correctly merge concurrent offline deletions', () => {
      const baseDoc = Automerge.from<AutomergeIndexDocument>({
        itemIds: ['item-1', 'item-2', 'item-3'] as ItemId[],
      })

      const docA = Automerge.change<AutomergeIndexDocument>(Automerge.clone(baseDoc), doc => {
        if (!doc.itemIds) doc.itemIds = []
        const removeSet = new Set(['item-2'])
        for (let i = doc.itemIds.length - 1; i >= 0; i--) {
          if (removeSet.has(doc.itemIds[i])) {
            doc.itemIds.splice(i, 1)
          }
        }
      })

      const docB = Automerge.change<AutomergeIndexDocument>(Automerge.clone(baseDoc), doc => {
        if (!doc.itemIds) doc.itemIds = []
        const removeSet = new Set(['item-3'])
        for (let i = doc.itemIds.length - 1; i >= 0; i--) {
          if (removeSet.has(doc.itemIds[i])) {
            doc.itemIds.splice(i, 1)
          }
        }
      })

      const merged = Automerge.merge(docA, docB)

      expect(merged.itemIds).toEqual(['item-1'])
    })

    it('PROVES FIX WORKS: concurrent addition and deletion merge correctly', () => {
      const baseDoc = Automerge.from<AutomergeIndexDocument>({
        itemIds: ['item-1', 'item-2'] as ItemId[],
      })

      const docA = Automerge.change<AutomergeIndexDocument>(Automerge.clone(baseDoc), doc => {
        if (!doc.itemIds) doc.itemIds = []
        const current = new Set(doc.itemIds)
        if (!current.has('item-3' as ItemId)) {
          doc.itemIds.push('item-3' as ItemId)
        }
      })

      const docB = Automerge.change<AutomergeIndexDocument>(Automerge.clone(baseDoc), doc => {
        if (!doc.itemIds) doc.itemIds = []
        const removeSet = new Set(['item-2'])
        for (let i = doc.itemIds.length - 1; i >= 0; i--) {
          if (removeSet.has(doc.itemIds[i])) {
            doc.itemIds.splice(i, 1)
          }
        }
      })

      const merged = Automerge.merge(docA, docB)

      expect(merged.itemIds).toContain('item-1')
      expect(merged.itemIds).toContain('item-3')
      expect(merged.itemIds).not.toContain('item-2')
      expect(merged.itemIds?.length).toBe(2)
    })
  })
})
