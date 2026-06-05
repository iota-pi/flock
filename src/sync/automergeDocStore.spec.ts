import { Repo } from '@automerge/automerge-repo/slim'
import * as Automerge from '@automerge/automerge/slim'
import {
  addAutomergeItemIdsToIndex,
  removeAutomergeItemIdsFromIndex,
  initializeAutomergeDocStore,
  listAutomergeItemIds,
  clearAutomergeDocStore,
  AutomergeIndexDocument,
} from './automergeDocStore'

// Instantiate a single Ephemeral/In-Memory Repo for standard doc store testing
const testRepo = new Repo()

vi.mock('./automergeRepo', () => {
  return {
    getAutomergeRepo: () => testRepo,
    getAutomergeDBName: () => 'flock-automerge-test-db',
  }
})

describe('automergeDocStore', () => {
  const accountId = 'test-account-id'

  beforeEach(async () => {
    // Clean and re-initialize index document for the test account
    await clearAutomergeDocStore(accountId)
    await initializeAutomergeDocStore(accountId)
  })

  describe('Basic Add and Remove Operations', () => {
    it('should add item IDs to the index correctly', async () => {
      await addAutomergeItemIdsToIndex(accountId, ['item-1', 'item-2'])
      const itemIds = await listAutomergeItemIds(accountId)
      expect(itemIds).toEqual(['item-1', 'item-2'])
    })

    it('should deduplicate item IDs upon insertion', async () => {
      await addAutomergeItemIdsToIndex(accountId, ['item-1', 'item-2'])
      await addAutomergeItemIdsToIndex(accountId, ['item-2', 'item-3'])
      const itemIds = await listAutomergeItemIds(accountId)
      expect(itemIds).toEqual(['item-1', 'item-2', 'item-3'])
    })

    it('should remove item IDs from the index correctly', async () => {
      await addAutomergeItemIdsToIndex(accountId, ['item-1', 'item-2', 'item-3'])
      await removeAutomergeItemIdsFromIndex(accountId, ['item-2'])
      const itemIds = await listAutomergeItemIds(accountId)
      expect(itemIds).toEqual(['item-1', 'item-3'])
    })

    it('should handle removing non-existent item IDs gracefully', async () => {
      await addAutomergeItemIdsToIndex(accountId, ['item-1'])
      await removeAutomergeItemIdsFromIndex(accountId, ['non-existent'])
      const itemIds = await listAutomergeItemIds(accountId)
      expect(itemIds).toEqual(['item-1'])
    })
  })

  describe('Concurrent Offline Edits and Conflict Resolution (CRDT Merge Proof)', () => {
    it('PROVES OLD BEHAVIOR FAILED: full array reassignments lead to data loss on concurrent merge', () => {
      // 1. Establish base index document
      const baseDoc = Automerge.from<AutomergeIndexDocument>({
        itemIds: ['item-base'],
      })

      // 2. Simulate Device A adding 'item-a' offline (OLD REASSIGNMENT METHOD)
      const docA = Automerge.change<AutomergeIndexDocument>(Automerge.clone(baseDoc), doc => {
        // doc.itemIds = Array.from(next)
        doc.itemIds = ['item-base', 'item-a']
      })

      // 3. Simulate Device B adding 'item-b' offline (OLD REASSIGNMENT METHOD)
      const docB = Automerge.change<AutomergeIndexDocument>(Automerge.clone(baseDoc), doc => {
        // doc.itemIds = Array.from(next)
        doc.itemIds = ['item-base', 'item-b']
      })

      // 4. Merge Devices A & B upon reconnection
      const merged = Automerge.merge(docA, docB)

      // 5. Automerge resolves this as a property conflict: it picks one device's array completely
      // and discards the other. There is no merging at the list level.
      expect(merged.itemIds?.length).toBe(2) // Only base + one device's addition exists
      const hasA = merged.itemIds?.includes('item-a')
      const hasB = merged.itemIds?.includes('item-b')
      expect(hasA !== hasB).toBe(true) // Exactly one is kept, the other is lost!
    })

    it('PROVES FIX WORKS: push-based in-place mutations correctly merge concurrent offline additions', () => {
      // 1. Establish base index document
      const baseDoc = Automerge.from<AutomergeIndexDocument>({
        itemIds: ['item-base'],
      })

      // 2. Simulate Device A adding 'item-a' offline using our new push logic
      const docA = Automerge.change<AutomergeIndexDocument>(Automerge.clone(baseDoc), doc => {
        if (!doc.itemIds) doc.itemIds = []
        const current = new Set(doc.itemIds)
        if (!current.has('item-a')) {
          doc.itemIds.push('item-a')
        }
      })

      // 3. Simulate Device B adding 'item-b' offline using our new push logic
      const docB = Automerge.change<AutomergeIndexDocument>(Automerge.clone(baseDoc), doc => {
        if (!doc.itemIds) doc.itemIds = []
        const current = new Set(doc.itemIds)
        if (!current.has('item-b')) {
          doc.itemIds.push('item-b')
        }
      })

      // 4. Merge Devices A & B upon reconnection
      const merged = Automerge.merge(docA, docB)

      // 5. Verify both items are preserved and merged correctly at the list level!
      expect(merged.itemIds).toContain('item-base')
      expect(merged.itemIds).toContain('item-a')
      expect(merged.itemIds).toContain('item-b')
      expect(merged.itemIds?.length).toBe(3)
    })

    it('PROVES FIX WORKS: splice-based in-place mutations correctly merge concurrent offline deletions', () => {
      // 1. Establish base index document
      const baseDoc = Automerge.from<AutomergeIndexDocument>({
        itemIds: ['item-1', 'item-2', 'item-3'],
      })

      // 2. Simulate Device A removing 'item-2' offline
      const docA = Automerge.change<AutomergeIndexDocument>(Automerge.clone(baseDoc), doc => {
        if (!doc.itemIds) doc.itemIds = []
        const removeSet = new Set(['item-2'])
        for (let i = doc.itemIds.length - 1; i >= 0; i--) {
          if (removeSet.has(doc.itemIds[i])) {
            doc.itemIds.splice(i, 1)
          }
        }
      })

      // 3. Simulate Device B removing 'item-3' offline
      const docB = Automerge.change<AutomergeIndexDocument>(Automerge.clone(baseDoc), doc => {
        if (!doc.itemIds) doc.itemIds = []
        const removeSet = new Set(['item-3'])
        for (let i = doc.itemIds.length - 1; i >= 0; i--) {
          if (removeSet.has(doc.itemIds[i])) {
            doc.itemIds.splice(i, 1)
          }
        }
      })

      // 4. Merge Devices A & B upon reconnection
      const merged = Automerge.merge(docA, docB)

      // 5. Verify both deletions are preserved and merged correctly
      expect(merged.itemIds).toEqual(['item-1'])
    })

    it('PROVES FIX WORKS: concurrent addition and deletion merge correctly', () => {
      // 1. Establish base index document
      const baseDoc = Automerge.from<AutomergeIndexDocument>({
        itemIds: ['item-1', 'item-2'],
      })

      // 2. Simulate Device A adding 'item-3'
      const docA = Automerge.change<AutomergeIndexDocument>(Automerge.clone(baseDoc), doc => {
        if (!doc.itemIds) doc.itemIds = []
        const current = new Set(doc.itemIds)
        if (!current.has('item-3')) {
          doc.itemIds.push('item-3')
        }
      })

      // 3. Simulate Device B removing 'item-2'
      const docB = Automerge.change<AutomergeIndexDocument>(Automerge.clone(baseDoc), doc => {
        if (!doc.itemIds) doc.itemIds = []
        const removeSet = new Set(['item-2'])
        for (let i = doc.itemIds.length - 1; i >= 0; i--) {
          if (removeSet.has(doc.itemIds[i])) {
            doc.itemIds.splice(i, 1)
          }
        }
      })

      // 4. Merge
      const merged = Automerge.merge(docA, docB)

      // 5. Verify 'item-3' is added and 'item-2' is removed
      expect(merged.itemIds).toContain('item-1')
      expect(merged.itemIds).toContain('item-3')
      expect(merged.itemIds).not.toContain('item-2')
      expect(merged.itemIds?.length).toBe(2)
    })
  })
})
