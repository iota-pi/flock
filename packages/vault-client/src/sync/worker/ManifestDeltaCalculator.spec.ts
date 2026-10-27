import { ManifestDeltaCalculator } from './ManifestDeltaCalculator'
import type { ItemId } from '@vault/shared'

describe('ManifestDeltaCalculator', () => {
  describe('calculateSyncDeltas', () => {
    it('partitions deltas correctly into missingIds, locallyTombstonedSnapshots, and upstreamIds', () => {
      const result = ManifestDeltaCalculator.calculateSyncDeltas({
        manifest: [
          { itemId: 'item-new-remote' as ItemId, version: 1, modifiedAt: 2000 },
          { itemId: 'item-server-deleted' as ItemId, version: 2, modifiedAt: 2000, isDeleted: true },
          { itemId: 'item-in-sync' as ItemId, version: 1, modifiedAt: 1000 },
        ],
        force: false,
        knownItemIds: ['item-server-deleted' as ItemId, 'item-in-sync' as ItemId, 'item-local-only' as ItemId],
        tombstoneItemIds: [],
        localLastModifiedMap: new Map([
          ['item-server-deleted' as ItemId, 1000],
          ['item-in-sync' as ItemId, 1000],
          ['item-local-only' as ItemId, 1500],
        ]),
        quarantinedMap: new Map(),
        localVersionsMap: new Map([
          ['item-server-deleted' as ItemId, { baseVersion: 1, isDirty: false }],
          ['item-in-sync' as ItemId, { baseVersion: 1, isDirty: false }],
          ['item-local-only' as ItemId, { baseVersion: 0, isDirty: true }],
        ]),
      })

      expect(result.missingIds).toEqual(['item-new-remote'])
      expect(result.locallyTombstonedSnapshots).toEqual([{ id: 'item-server-deleted', deleted: true }])
      expect(result.deletedLastModifiedUpdates).toEqual([['item-server-deleted', 2000]])
      expect(result.upstreamIds).toEqual(['item-local-only'])
      expect(result.knownSet.has('item-in-sync' as ItemId)).toBe(true)
    })

    it('skips a quarantined item until the server has a newer version than the one that failed', () => {
      const result = ManifestDeltaCalculator.calculateSyncDeltas({
        manifest: [
          // Server clock far behind the quarantine time, but a newer version: fetched
          { itemId: 'item-newer' as ItemId, version: 6, modifiedAt: 100 },
          // Server clock far ahead of the quarantine time, but the same version that failed: skipped
          { itemId: 'item-same' as ItemId, version: 5, modifiedAt: 999_999 },
          { itemId: 'item-older' as ItemId, version: 4, modifiedAt: 999_999 },
        ],
        force: false,
        knownItemIds: ['item-newer' as ItemId, 'item-same' as ItemId, 'item-older' as ItemId],
        tombstoneItemIds: [],
        localLastModifiedMap: new Map(),
        quarantinedMap: new Map([
          ['item-newer' as ItemId, { serverVersion: 5 }],
          ['item-same' as ItemId, { serverVersion: 5 }],
          ['item-older' as ItemId, { serverVersion: 5 }],
        ]),
        // A failed hydration leaves baseVersion behind the version that failed
        localVersionsMap: new Map([
          ['item-newer' as ItemId, { baseVersion: 2, isDirty: false }],
          ['item-same' as ItemId, { baseVersion: 2, isDirty: false }],
          ['item-older' as ItemId, { baseVersion: 2, isDirty: false }],
        ]),
      })

      expect(result.missingIds).toEqual(['item-newer'])
      expect(result.upstreamIds).toEqual([])
    })

    it('falls back to baseVersion for quarantine entries without a recorded server version', () => {
      const result = ManifestDeltaCalculator.calculateSyncDeltas({
        manifest: [
          { itemId: 'item-legacy-newer' as ItemId, version: 4, modifiedAt: 100 },
          { itemId: 'item-legacy-same' as ItemId, version: 3, modifiedAt: 999_999 },
          { itemId: 'item-legacy-unknown' as ItemId, version: 1, modifiedAt: 100 },
        ],
        force: false,
        knownItemIds: ['item-legacy-newer' as ItemId, 'item-legacy-same' as ItemId],
        tombstoneItemIds: [],
        localLastModifiedMap: new Map(),
        quarantinedMap: new Map([
          ['item-legacy-newer' as ItemId, {}],
          ['item-legacy-same' as ItemId, {}],
          ['item-legacy-unknown' as ItemId, {}],
        ]),
        localVersionsMap: new Map([
          ['item-legacy-newer' as ItemId, { baseVersion: 3, isDirty: false }],
          ['item-legacy-same' as ItemId, { baseVersion: 3, isDirty: false }],
        ]),
      })

      expect(result.missingIds).toEqual(['item-legacy-newer', 'item-legacy-unknown'])
    })

    it('never skips past baseVersion when the recorded server version is older', () => {
      const result = ManifestDeltaCalculator.calculateSyncDeltas({
        manifest: [{ itemId: 'item-1' as ItemId, version: 4, modifiedAt: 100 }],
        force: false,
        knownItemIds: ['item-1' as ItemId],
        tombstoneItemIds: [],
        localLastModifiedMap: new Map(),
        quarantinedMap: new Map([['item-1' as ItemId, { serverVersion: 2 }]]),
        localVersionsMap: new Map([['item-1' as ItemId, { baseVersion: 4, isDirty: false }]]),
      })

      expect(result.missingIds).toEqual([])
    })

    it('does not filter quarantined items when force is true', () => {
      const result = ManifestDeltaCalculator.calculateSyncDeltas({
        manifest: [
          { itemId: 'item-quarantined-old' as ItemId, version: 5, modifiedAt: 500 },
        ],
        force: true,
        knownItemIds: [],
        tombstoneItemIds: [],
        localLastModifiedMap: new Map(),
        quarantinedMap: new Map([
          ['item-quarantined-old' as ItemId, { serverVersion: 5 }],
        ]),
        localVersionsMap: new Map(),
      })

      expect(result.missingIds).toEqual(['item-quarantined-old'])
    })

    it('never resurrects locally tombstoned items with active server snapshot', () => {
      const result = ManifestDeltaCalculator.calculateSyncDeltas({
        manifest: [
          { itemId: 'item-tombstoned' as ItemId, modifiedAt: 5000 }, // active on server
        ],
        force: false,
        knownItemIds: [],
        tombstoneItemIds: ['item-tombstoned' as ItemId],
        localLastModifiedMap: new Map([
          ['item-tombstoned' as ItemId, 4000],
        ]),
        quarantinedMap: new Map(),
        localVersionsMap: new Map(),
      })

      expect(result.missingIds).not.toContain('item-tombstoned')
      expect(result.upstreamIds).toContain('item-tombstoned') // pushes local tombstone upstream!
    })

    it('records server deleted timestamp for inactive item without fetching snapshot', () => {
      const result = ManifestDeltaCalculator.calculateSyncDeltas({
        manifest: [
          { itemId: 'item-server-del' as ItemId, version: 2, modifiedAt: 3000, isDeleted: true },
        ],
        force: false,
        knownItemIds: [], // not in active items
        tombstoneItemIds: [],
        localLastModifiedMap: new Map([
          ['item-server-del' as ItemId, 1000],
        ]),
        quarantinedMap: new Map(),
        localVersionsMap: new Map([
          ['item-server-del' as ItemId, { baseVersion: 1, isDirty: false }],
        ]),
      })

      expect(result.missingIds).toHaveLength(0)
      expect(result.locallyTombstonedSnapshots).toHaveLength(0)
      expect(result.deletedLastModifiedUpdates).toEqual([['item-server-del', 3000]])
      expect(result.deletedVersionUpdates).toEqual([['item-server-del', 2]])
    })

    it('ignores a server deletion of an inactive item it has already recorded', () => {
      const result = ManifestDeltaCalculator.calculateSyncDeltas({
        manifest: [
          { itemId: 'item-server-del' as ItemId, version: 2, modifiedAt: 3000, isDeleted: true },
        ],
        force: false,
        knownItemIds: [],
        tombstoneItemIds: [],
        localLastModifiedMap: new Map([
          ['item-server-del' as ItemId, 3000],
        ]),
        quarantinedMap: new Map(),
        localVersionsMap: new Map([
          ['item-server-del' as ItemId, { baseVersion: 2, isDirty: false }],
        ]),
      })

      expect(result.deletedLastModifiedUpdates).toHaveLength(0)
      expect(result.deletedVersionUpdates).toHaveLength(0)
    })
  })

  describe('version comparison', () => {
    it('pulls inbound when serverVersion > baseVersion even if client physical clock is far ahead', () => {
      const result = ManifestDeltaCalculator.calculateSyncDeltas({
        manifest: [
          // Server has version 5, modifiedAt 1000
          { itemId: 'item-1' as ItemId, version: 5, modifiedAt: 1000 },
        ],
        force: false,
        knownItemIds: ['item-1' as ItemId],
        tombstoneItemIds: [],
        localLastModifiedMap: new Map([
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

    it('does not push quarantined items upstream unless forced', () => {
      const params = {
        manifest: [
          { itemId: 'item-quarantined-dirty' as ItemId, version: 3, modifiedAt: 1000 },
        ],
        knownItemIds: ['item-quarantined-new' as ItemId, 'item-quarantined-dirty' as ItemId],
        tombstoneItemIds: [],
        localLastModifiedMap: new Map(),
        quarantinedMap: new Map([
          ['item-quarantined-new' as ItemId, {}],
          ['item-quarantined-dirty' as ItemId, {}],
        ]),
        localVersionsMap: new Map([
          ['item-quarantined-new' as ItemId, { baseVersion: 0, isDirty: true }],
          ['item-quarantined-dirty' as ItemId, { baseVersion: 3, isDirty: true }],
        ]),
      }

      expect(ManifestDeltaCalculator.calculateSyncDeltas({ ...params, force: false }).upstreamIds).toEqual([])
      // A forced sync retries them: the one on the server is fetched, the other is pushed
      const forced = ManifestDeltaCalculator.calculateSyncDeltas({ ...params, force: true })
      expect(forced.missingIds).toEqual(['item-quarantined-dirty'])
      expect(forced.upstreamIds).toEqual(['item-quarantined-new'])
    })

    it('tombstones local active item when server manifest marks it deleted and records serverVersion', () => {
      const result = ManifestDeltaCalculator.calculateSyncDeltas({
        manifest: [
          { itemId: 'item-del' as ItemId, version: 7, isDeleted: true, modifiedAt: 5000 },
        ],
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
