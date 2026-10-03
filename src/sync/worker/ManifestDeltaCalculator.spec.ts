import { ManifestDeltaCalculator, SKEW_BUFFER_MS } from './ManifestDeltaCalculator'
import type { ItemId } from '../../shared/schemas/items'

describe('ManifestDeltaCalculator', () => {
  describe('calculateSyncDeltas', () => {
    it('partitions deltas correctly into missingIds, locallyTombstonedSnapshots, and upstreamIds', () => {
      const result = ManifestDeltaCalculator.calculateSyncDeltas({
        manifest: [
          { itemId: 'item-new-remote' as ItemId, modifiedAt: 2000 },
          { itemId: 'item-server-deleted' as ItemId, modifiedAt: 2000, isDeleted: true },
          { itemId: 'item-in-sync' as ItemId, modifiedAt: 1000 },
        ],
        clockSkew: 0,
        force: false,
        knownItemIds: ['item-server-deleted' as ItemId, 'item-in-sync' as ItemId, 'item-local-only' as ItemId],
        tombstoneItemIds: [],
        localLastModifiedMap: new Map([
          ['item-server-deleted' as ItemId, 1000],
          ['item-in-sync' as ItemId, 1000],
          ['item-local-only' as ItemId, 1500],
        ]),
        quarantinedMap: new Map(),
      })

      expect(result.missingIds).toEqual(['item-new-remote'])
      expect(result.locallyTombstonedSnapshots).toEqual([{ id: 'item-server-deleted', deleted: true }])
      expect(result.deletedLastModifiedUpdates).toEqual([['item-server-deleted', 2000]])
      expect(result.upstreamIds).toEqual(['item-local-only'])
      expect(result.knownSet.has('item-in-sync' as ItemId)).toBe(true)
    })

    it('filters quarantined items unless server has a newer timestamp', () => {
      const result = ManifestDeltaCalculator.calculateSyncDeltas({
        manifest: [
          { itemId: 'item-quarantined-old' as ItemId, modifiedAt: 500 },
          { itemId: 'item-quarantined-new' as ItemId, modifiedAt: 1500 },
        ],
        clockSkew: 0,
        force: false,
        knownItemIds: [],
        tombstoneItemIds: [],
        localLastModifiedMap: new Map(),
        quarantinedMap: new Map([
          ['item-quarantined-old' as ItemId, 600],
          ['item-quarantined-new' as ItemId, 1000],
        ]),
      })

      expect(result.missingIds).toEqual(['item-quarantined-new'])
    })

    it('does not filter quarantined items when force is true', () => {
      const result = ManifestDeltaCalculator.calculateSyncDeltas({
        manifest: [
          { itemId: 'item-quarantined-old' as ItemId, modifiedAt: 500 },
        ],
        clockSkew: 0,
        force: true,
        knownItemIds: [],
        tombstoneItemIds: [],
        localLastModifiedMap: new Map(),
        quarantinedMap: new Map([
          ['item-quarantined-old' as ItemId, 600],
        ]),
      })

      expect(result.missingIds).toEqual(['item-quarantined-old'])
    })

    it('never resurrects locally tombstoned items with active server snapshot', () => {
      const result = ManifestDeltaCalculator.calculateSyncDeltas({
        manifest: [
          { itemId: 'item-tombstoned' as ItemId, modifiedAt: 5000 }, // active on server
        ],
        clockSkew: 0,
        force: false,
        knownItemIds: [],
        tombstoneItemIds: ['item-tombstoned' as ItemId],
        localLastModifiedMap: new Map([
          ['item-tombstoned' as ItemId, 4000],
        ]),
        quarantinedMap: new Map(),
      })

      expect(result.missingIds).not.toContain('item-tombstoned')
      expect(result.upstreamIds).toContain('item-tombstoned') // pushes local tombstone upstream!
    })

    it('records server deleted timestamp for inactive item without fetching snapshot', () => {
      const result = ManifestDeltaCalculator.calculateSyncDeltas({
        manifest: [
          { itemId: 'item-server-del' as ItemId, modifiedAt: 3000, isDeleted: true },
        ],
        clockSkew: 0,
        force: false,
        knownItemIds: [], // not in active items
        tombstoneItemIds: [],
        localLastModifiedMap: new Map([
          ['item-server-del' as ItemId, 1000],
        ]),
        quarantinedMap: new Map(),
      })

      expect(result.missingIds).toHaveLength(0)
      expect(result.locallyTombstonedSnapshots).toHaveLength(0)
      expect(result.deletedLastModifiedUpdates).toEqual([['item-server-del', 3000]])
    })

    it('applies clock skew and buffer compensation to inbound check', () => {
      const localTime = 10000
      const serverTime = localTime - 10 // slightly behind localTime
      // With clockSkew 0, adjustedLocalTime = 10000 - 60000 = -50000.
      // Since serverTime (9990) > adjustedLocalTime (-50000), it treats it as missing (clock skew safety).
      const result = ManifestDeltaCalculator.calculateSyncDeltas({
        manifest: [
          { itemId: 'item-skew' as ItemId, modifiedAt: serverTime },
        ],
        clockSkew: 0,
        force: false,
        knownItemIds: ['item-skew' as ItemId],
        tombstoneItemIds: [],
        localLastModifiedMap: new Map([
          ['item-skew' as ItemId, localTime],
        ]),
        quarantinedMap: new Map(),
      })

      expect(result.missingIds).toContain('item-skew')
    })

    it('pushes upstream when local modified exceeds server time plus skew buffer', () => {
      const serverTime = 1000
      const localTime = serverTime + SKEW_BUFFER_MS + 5000 // well ahead
      const result = ManifestDeltaCalculator.calculateSyncDeltas({
        manifest: [
          { itemId: 'item-local-newer' as ItemId, modifiedAt: serverTime },
        ],
        clockSkew: 0,
        force: false,
        knownItemIds: ['item-local-newer' as ItemId],
        tombstoneItemIds: [],
        localLastModifiedMap: new Map([
          ['item-local-newer' as ItemId, localTime],
        ]),
        quarantinedMap: new Map(),
      })

      expect(result.upstreamIds).toContain('item-local-newer')
    })
  })

  describe('with localVersionsMap (Monotonic Snapshot Revisions)', () => {
    it('pulls inbound when serverVersion > baseVersion even if client physical clock is far ahead', () => {
      const result = ManifestDeltaCalculator.calculateSyncDeltas({
        manifest: [
          // Server has version 5, modifiedAt 1000
          { itemId: 'item-1' as ItemId, version: 5, modifiedAt: 1000 },
        ],
        clockSkew: 0,
        force: false,
        knownItemIds: ['item-1' as ItemId],
        tombstoneItemIds: [],
        localLastModifiedMap: new Map([
          // Local physical clock was 999999 (far ahead), which would break legacy timestamp comparison
          ['item-1' as ItemId, 999999],
        ]),
        quarantinedMap: new Map(),
        localVersionsMap: new Map([
          ['item-1' as ItemId, { baseVersion: 4, isDirty: false }],
        ]),
      })

      // Monotonic version 5 > 4 forces inbound fetch regardless of physical timestamps
      expect(result.missingIds).toEqual(['item-1'])
      expect(result.upstreamIds).toHaveLength(0)
    })

    it('skips sync (in-sync) when serverVersion === baseVersion and isDirty is false', () => {
      const result = ManifestDeltaCalculator.calculateSyncDeltas({
        manifest: [
          { itemId: 'item-sync' as ItemId, version: 3, modifiedAt: 1000 },
        ],
        clockSkew: 0,
        force: false,
        knownItemIds: ['item-sync' as ItemId],
        tombstoneItemIds: [],
        localLastModifiedMap: new Map([
          ['item-sync' as ItemId, 500], // physical timestamps differ, but versions match
        ]),
        quarantinedMap: new Map(),
        localVersionsMap: new Map([
          ['item-sync' as ItemId, { baseVersion: 3, isDirty: false }],
        ]),
      })

      expect(result.missingIds).toHaveLength(0)
      expect(result.upstreamIds).toHaveLength(0)
    })

    it('pushes upstream when serverVersion === baseVersion and isDirty is true', () => {
      const result = ManifestDeltaCalculator.calculateSyncDeltas({
        manifest: [
          { itemId: 'item-dirty' as ItemId, version: 3, modifiedAt: 2000 },
        ],
        clockSkew: 0,
        force: false,
        knownItemIds: ['item-dirty' as ItemId],
        tombstoneItemIds: [],
        localLastModifiedMap: new Map([
          ['item-dirty' as ItemId, 2000],
        ]),
        quarantinedMap: new Map(),
        localVersionsMap: new Map([
          ['item-dirty' as ItemId, { baseVersion: 3, isDirty: true }],
        ]),
      })

      expect(result.missingIds).toHaveLength(0)
      expect(result.upstreamIds).toEqual(['item-dirty'])
    })

    it('pushes upstream when item exists locally but is completely missing from server manifest', () => {
      const result = ManifestDeltaCalculator.calculateSyncDeltas({
        manifest: [],
        clockSkew: 0,
        force: false,
        knownItemIds: ['item-offline-created' as ItemId],
        tombstoneItemIds: [],
        localLastModifiedMap: new Map(),
        quarantinedMap: new Map(),
        localVersionsMap: new Map([
          ['item-offline-created' as ItemId, { baseVersion: 0, isDirty: true }],
        ]),
      })

      expect(result.missingIds).toHaveLength(0)
      expect(result.upstreamIds).toEqual(['item-offline-created'])
    })

    it('tombstones local active item when server manifest marks it deleted and records serverVersion', () => {
      const result = ManifestDeltaCalculator.calculateSyncDeltas({
        manifest: [
          { itemId: 'item-del' as ItemId, version: 7, isDeleted: true, modifiedAt: 5000 },
        ],
        clockSkew: 0,
        force: false,
        knownItemIds: ['item-del' as ItemId],
        tombstoneItemIds: [],
        localLastModifiedMap: new Map([
          ['item-del' as ItemId, 3000],
        ]),
        quarantinedMap: new Map(),
        localVersionsMap: new Map([
          ['item-del' as ItemId, { baseVersion: 6, isDirty: false }],
        ]),
      })

      expect(result.locallyTombstonedSnapshots).toEqual([{ id: 'item-del', deleted: true }])
      expect(result.deletedVersionUpdates).toEqual([['item-del', 7]])
      expect(result.upstreamIds).toHaveLength(0)
    })

    it('pushes local tombstone upstream when server still has active snapshot', () => {
      const result = ManifestDeltaCalculator.calculateSyncDeltas({
        manifest: [
          { itemId: 'item-tomb' as ItemId, version: 2, isDeleted: false, modifiedAt: 1000 },
        ],
        clockSkew: 0,
        force: false,
        knownItemIds: [],
        tombstoneItemIds: ['item-tomb' as ItemId],
        localLastModifiedMap: new Map(),
        quarantinedMap: new Map(),
        localVersionsMap: new Map([
          ['item-tomb' as ItemId, { baseVersion: 2, isDirty: true }],
        ]),
      })

      expect(result.missingIds).not.toContain('item-tomb')
      expect(result.upstreamIds).toEqual(['item-tomb'])
    })
  })
})
