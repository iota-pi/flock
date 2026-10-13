import type { Item } from '../../state/items'
import type { ItemId } from 'src/shared/schemas/items'
import type { ManifestEntry } from 'src/shared/schemas/trpc'

export const SKEW_BUFFER_MS = 60 * 1000

export interface SyncDeltas {
  missingIds: ItemId[]
  upstreamIds: ItemId[]
  locallyTombstonedSnapshots: Item[]
  deletedLastModifiedUpdates: [ItemId, number][]
  deletedVersionUpdates?: [ItemId, number][]
  knownSet: Set<ItemId>
  tombstoneSet: Set<ItemId>
}

export interface CalculateSyncDeltasParams {
  manifest: ManifestEntry[]
  clockSkew: number
  force: boolean
  knownItemIds: ItemId[]
  tombstoneItemIds: ItemId[]
  localLastModifiedMap: Map<ItemId, number>
  quarantinedMap: Map<ItemId, number>
  localVersionsMap?: Map<ItemId, { baseVersion: number; isDirty: boolean }>
}

export interface CalculateInboundDeltasParams {
  manifest: ManifestEntry[]
  activeSet: Set<ItemId>
  tombstoneSet: Set<ItemId>
  knownSet: Set<ItemId>
  quarantinedMap: Map<ItemId, number>
  localLastModifiedMap: Map<ItemId, number>
  clockSkew: number
  force: boolean
  localVersionsMap?: Map<ItemId, { baseVersion: number; isDirty: boolean }>
}

export interface CalculateUpstreamDeltasParams {
  allLocalIds: Set<ItemId>
  missingSet: Set<ItemId>
  locallyTombstonedSet: Set<ItemId>
  tombstoneSet: Set<ItemId>
  serverManifestMap: Map<ItemId, number>
  serverDeletedSet: Set<ItemId>
  localLastModifiedMap: Map<ItemId, number>
  clockSkew: number
  localVersionsMap?: Map<ItemId, { baseVersion: number; isDirty: boolean }>
}

export class ManifestDeltaCalculator {
  static calculateInboundDeltas(params: CalculateInboundDeltasParams) {
    const locallyTombstonedSnapshots: Item[] = []
    const deletedLastModifiedUpdates: [ItemId, number][] = []
    const deletedVersionUpdates: [ItemId, number][] = []
    const missingIds: ItemId[] = []

    for (const entry of params.manifest) {
      const id = entry.itemId
      if (!id) continue
      const serverTime = entry.modifiedAt ?? 0
      const serverVersion = typeof entry.version === 'number' ? entry.version : 1
      const isDeleted = entry.isDeleted

      // If not forced and item is currently quarantined in manual recovery:
      // skip unless the server has a newer snapshot timestamp than when it was quarantined
      if (!params.force && params.quarantinedMap.has(id)) {
        const quarantinedAt = params.quarantinedMap.get(id) ?? 0
        if (serverTime <= quarantinedAt) {
          continue
        }
      }

      const localTime = params.localLastModifiedMap.get(id) ?? 0
      const localVersionInfo = params.localVersionsMap?.get(id)

      if (isDeleted) {
        if (params.activeSet.has(id)) {
          // Item exists locally and is active, but the server manifest indicates it is deleted.
          // Apply tombstone locally and record timestamp to prevent resurrection.
          locallyTombstonedSnapshots.push({ id, deleted: true } as unknown as Item)
          deletedLastModifiedUpdates.push([id, serverTime])
          deletedVersionUpdates.push([id, serverVersion])
        } else if (
          params.localVersionsMap
            ? serverVersion > (localVersionInfo?.baseVersion ?? 0)
            : serverTime > localTime
        ) {
          // Item is deleted on server and client does not have it active (e.g. fresh login or already deleted).
          // Track that this item exists and is deleted at serverTime/serverVersion without fetching snapshot.
          deletedLastModifiedUpdates.push([id, serverTime])
          deletedVersionUpdates.push([id, serverVersion])
        }
        continue
      }

      // If the item is already tombstoned locally, the local tombstone is terminal and authoritative.
      // Do NOT fetch older or concurrent active snapshot from server, which would cause resurrection.
      if (params.tombstoneSet.has(id)) {
        continue
      }

      // If the item was quarantined and not skipped above (either force is true or server has newer timestamp),
      // fetch it immediately to retry recovery.
      if (params.quarantinedMap.has(id)) {
        missingIds.push(id)
        continue
      }

      if (params.localVersionsMap) {
        // MONOTONIC VERSION LOGIC: Deterministic version comparison
        if (!params.knownSet.has(id)) {
          missingIds.push(id)
          continue
        }
        const baseVersion = localVersionInfo?.baseVersion ?? 0
        if (serverVersion > baseVersion) {
          missingIds.push(id)
          continue
        }
        continue
      }

      // LEGACY TIMESTAMP FALLBACK (when localVersionsMap is not provided)
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

    return { missingIds, locallyTombstonedSnapshots, deletedLastModifiedUpdates, deletedVersionUpdates }
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
      } else if (params.tombstoneSet.has(localId)) {
        // If tombstoned locally, push upstream ONLY if server still has an active snapshot
        if (!params.serverDeletedSet.has(localId)) {
          upstreamIds.push(localId)
        }
      } else if (params.localVersionsMap) {
        // MONOTONIC VERSION LOGIC:
        // If the local item is marked dirty, it has local changes that need to be pushed upstream
        const localVersionInfo = params.localVersionsMap.get(localId)
        if (localVersionInfo?.isDirty) {
          upstreamIds.push(localId)
        }
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
    const serverManifestMap = new Map<ItemId, number>(
      params.manifest.map(entry => [entry.itemId, entry.modifiedAt ?? 0]),
    )
    const serverDeletedSet = new Set<ItemId>(
      params.manifest
        .filter(entry => entry.isDeleted === true)
        .map(entry => entry.itemId),
    )

    const tombstoneSet = new Set(params.tombstoneItemIds)
    for (const [id] of params.localLastModifiedMap) {
      if (!activeSet.has(id)) {
        tombstoneSet.add(id)
      }
    }
    const knownSet = new Set([...activeSet, ...tombstoneSet])

    const { missingIds, locallyTombstonedSnapshots, deletedLastModifiedUpdates, deletedVersionUpdates } =
      ManifestDeltaCalculator.calculateInboundDeltas({
        manifest: params.manifest,
        activeSet,
        tombstoneSet,
        knownSet,
        quarantinedMap: params.quarantinedMap,
        localLastModifiedMap: params.localLastModifiedMap,
        clockSkew: params.clockSkew,
        force: params.force,
        localVersionsMap: params.localVersionsMap,
      })

    // Two-Way Manifest Reconciliation (Upstream):
    // Identify local items that need to be pushed as snapshots to the server.
    // Exclude items that were just locally tombstoned.
    const upstreamIds = ManifestDeltaCalculator.calculateUpstreamDeltas({
      allLocalIds: new Set([...params.knownItemIds, ...tombstoneSet]),
      missingSet: new Set(missingIds),
      locallyTombstonedSet: new Set(locallyTombstonedSnapshots.map(s => s.id)),
      tombstoneSet,
      serverManifestMap,
      serverDeletedSet,
      localLastModifiedMap: params.localLastModifiedMap,
      clockSkew: params.clockSkew,
      localVersionsMap: params.localVersionsMap,
    })

    return {
      missingIds,
      upstreamIds,
      locallyTombstonedSnapshots,
      deletedLastModifiedUpdates,
      deletedVersionUpdates,
      knownSet,
      tombstoneSet,
    }
  }
}
