import type { Item } from '../../state/items'
import type { ItemId } from 'src/shared/schemas/items'

export const SKEW_BUFFER_MS = 60 * 1000

export type ManifestEntry = [itemId: string, serverTime: number, isDeleted?: boolean]

export interface SyncDeltas {
  missingIds: ItemId[]
  upstreamIds: ItemId[]
  locallyTombstonedSnapshots: Item[]
  deletedLastModifiedUpdates: [ItemId, number][]
  knownSet: Set<ItemId>
  tombstoneSet: Set<ItemId>
}

export interface CalculateSyncDeltasParams {
  manifest: ManifestEntry[]
  clockSkew: number
  force: boolean
  knownItemIds: ItemId[]
  tombstoneItemIds: ItemId[]
  localLastModifiedMap: Map<string, number>
  quarantinedMap: Map<ItemId, number>
}

export interface CalculateInboundDeltasParams {
  manifest: ManifestEntry[]
  activeSet: Set<ItemId>
  tombstoneSet: Set<ItemId>
  knownSet: Set<ItemId>
  quarantinedMap: Map<ItemId, number>
  localLastModifiedMap: Map<string, number>
  clockSkew: number
  force: boolean
}

export interface CalculateUpstreamDeltasParams {
  allLocalIds: Set<ItemId>
  missingSet: Set<ItemId>
  locallyTombstonedSet: Set<ItemId>
  tombstoneSet: Set<ItemId>
  serverManifestMap: Map<string, number>
  serverDeletedSet: Set<string>
  localLastModifiedMap: Map<string, number>
  clockSkew: number
}

export class ManifestDeltaCalculator {
  static calculateInboundDeltas(params: CalculateInboundDeltasParams) {
    const locallyTombstonedSnapshots: Item[] = []
    const deletedLastModifiedUpdates: [ItemId, number][] = []
    const missingIds: ItemId[] = []

    for (const [itemId, serverTime, isDeleted] of params.manifest) {
      const id = itemId as ItemId
      if (!id) continue

      // If not forced and item is currently quarantined in manual recovery:
      // skip unless the server has a newer snapshot timestamp than when it was quarantined
      if (!params.force && params.quarantinedMap.has(id)) {
        const quarantinedAt = params.quarantinedMap.get(id) ?? 0
        if (serverTime <= quarantinedAt) {
          continue
        }
      }

      const localTime = params.localLastModifiedMap.get(id) ?? 0

      if (isDeleted) {
        if (params.activeSet.has(id)) {
          // Item exists locally and is active, but the server manifest indicates it is deleted.
          // Apply tombstone locally and record timestamp to prevent resurrection.
          locallyTombstonedSnapshots.push({ id, deleted: true } as unknown as Item)
          deletedLastModifiedUpdates.push([id, serverTime])
        } else if (serverTime > localTime) {
          // Item is deleted on server and client does not have it active (e.g. fresh login or already deleted).
          // Track that this item exists and is deleted at serverTime without fetching snapshot.
          deletedLastModifiedUpdates.push([id, serverTime])
        }
        continue
      }

      // If the item is already tombstoned locally, the local tombstone is terminal and authoritative.
      // Do NOT fetch older or concurrent active snapshot from server, which would cause resurrection.
      if (params.tombstoneSet.has(id)) {
        continue
      }

      if (localTime === 0) {
        missingIds.push(id)
        continue
      }
      if (params.force && !params.knownSet.has(id)) {
        missingIds.push(id)
        continue
      }
      if (serverTime === localTime) continue
      if (serverTime > localTime) {
        missingIds.push(id)
        continue
      }

      // Clock skew + buffer compensation for cases where client clock was ahead
      const adjustedLocalTime = localTime - Math.max(0, params.clockSkew) - SKEW_BUFFER_MS
      if (serverTime > adjustedLocalTime) {
        missingIds.push(id)
        continue
      }
    }

    return { missingIds, locallyTombstonedSnapshots, deletedLastModifiedUpdates }
  }

  static calculateUpstreamDeltas(params: CalculateUpstreamDeltasParams): ItemId[] {
    const upstreamIds: ItemId[] = []
    for (const localId of params.allLocalIds) {
      if (params.missingSet.has(localId) || params.locallyTombstonedSet.has(localId)) continue
      const serverTime = params.serverManifestMap.get(localId)
      const localTime = params.localLastModifiedMap.get(localId) ?? 0

      if (serverTime === undefined) {
        // Item exists locally but is completely missing from server manifest
        upstreamIds.push(localId)
      } else if (params.tombstoneSet.has(localId) && !params.serverDeletedSet.has(localId)) {
        // Item is tombstoned locally, but server still has an active snapshot: push tombstone upstream
        upstreamIds.push(localId)
      } else {
        // Clock skew + buffer compensation: if local time exceeds server time
        const adjustedLocalTime = localTime - Math.max(0, params.clockSkew) - SKEW_BUFFER_MS
        if (adjustedLocalTime > serverTime) {
          upstreamIds.push(localId)
        }
      }
    }
    return upstreamIds
  }

  static calculateSyncDeltas(params: CalculateSyncDeltasParams): SyncDeltas {
    const activeSet = new Set(params.knownItemIds)
    const serverManifestMap = new Map<string, number>(
      params.manifest.map(([itemId, serverTime]) => [itemId, serverTime]),
    )
    const serverDeletedSet = new Set<string>(
      params.manifest
        .filter(([, , isDeleted]) => isDeleted === true)
        .map(([itemId]) => itemId),
    )

    const tombstoneSet = new Set(params.tombstoneItemIds)
    for (const [id] of params.localLastModifiedMap) {
      if (!activeSet.has(id as ItemId)) {
        tombstoneSet.add(id as ItemId)
      }
    }
    const knownSet = new Set([...activeSet, ...tombstoneSet])

    const { missingIds, locallyTombstonedSnapshots, deletedLastModifiedUpdates } =
      ManifestDeltaCalculator.calculateInboundDeltas({
        manifest: params.manifest,
        activeSet,
        tombstoneSet,
        knownSet,
        quarantinedMap: params.quarantinedMap,
        localLastModifiedMap: params.localLastModifiedMap,
        clockSkew: params.clockSkew,
        force: params.force,
      })

    // Two-Way Manifest Reconciliation (Upstream):
    // Identify local items that need to be pushed as snapshots to the server.
    // Exclude items that were just locally tombstoned.
    const upstreamIds = ManifestDeltaCalculator.calculateUpstreamDeltas({
      allLocalIds: new Set([...params.knownItemIds, ...tombstoneSet]),
      missingSet: new Set(missingIds),
      locallyTombstonedSet: new Set(locallyTombstonedSnapshots.map(s => s.id as ItemId)),
      tombstoneSet,
      serverManifestMap,
      serverDeletedSet,
      localLastModifiedMap: params.localLastModifiedMap,
      clockSkew: params.clockSkew,
    })

    return {
      missingIds,
      upstreamIds,
      locallyTombstonedSnapshots,
      deletedLastModifiedUpdates,
      knownSet,
      tombstoneSet,
    }
  }
}
