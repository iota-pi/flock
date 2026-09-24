import { describe, it, expect } from 'vitest'
import { ManifestDeltaCalculator, SKEW_BUFFER_MS } from './ManifestDeltaCalculator'
import type { ItemId } from '../../shared/schemas/items'

describe('ManifestDeltaCalculator', () => {
  describe('calculateSyncDeltas', () => {
    it('partitions deltas correctly into missingIds, locallyTombstonedSnapshots, and upstreamIds', () => {
      const result = ManifestDeltaCalculator.calculateSyncDeltas({
        manifest: [
          ['item-new-remote', 2000],
          ['item-server-deleted', 2000, true],
          ['item-in-sync', 1000],
        ],
        clockSkew: 0,
        force: false,
        knownItemIds: ['item-server-deleted' as ItemId, 'item-in-sync' as ItemId, 'item-local-only' as ItemId],
        tombstoneItemIds: [],
        localLastModifiedMap: new Map([
          ['item-server-deleted', 1000],
          ['item-in-sync', 1000],
          ['item-local-only', 1500],
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
          ['item-quarantined-old', 500],
          ['item-quarantined-new', 1500],
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
          ['item-quarantined-old', 500],
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
          ['item-tombstoned', 5000], // active on server
        ],
        clockSkew: 0,
        force: false,
        knownItemIds: [],
        tombstoneItemIds: ['item-tombstoned' as ItemId],
        localLastModifiedMap: new Map([
          ['item-tombstoned', 4000],
        ]),
        quarantinedMap: new Map(),
      })

      expect(result.missingIds).not.toContain('item-tombstoned')
      expect(result.upstreamIds).toContain('item-tombstoned') // pushes local tombstone upstream!
    })

    it('records server deleted timestamp for inactive item without fetching snapshot', () => {
      const result = ManifestDeltaCalculator.calculateSyncDeltas({
        manifest: [
          ['item-server-del', 3000, true],
        ],
        clockSkew: 0,
        force: false,
        knownItemIds: [], // not in active items
        tombstoneItemIds: [],
        localLastModifiedMap: new Map([
          ['item-server-del', 1000],
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
          ['item-skew', serverTime],
        ],
        clockSkew: 0,
        force: false,
        knownItemIds: ['item-skew' as ItemId],
        tombstoneItemIds: [],
        localLastModifiedMap: new Map([
          ['item-skew', localTime],
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
          ['item-local-newer', serverTime],
        ],
        clockSkew: 0,
        force: false,
        knownItemIds: ['item-local-newer' as ItemId],
        tombstoneItemIds: [],
        localLastModifiedMap: new Map([
          ['item-local-newer', localTime],
        ]),
        quarantinedMap: new Map(),
      })

      expect(result.upstreamIds).toContain('item-local-newer')
    })
  })
})
