import type { VaultDoc } from '../shared/types'
import type { ItemId, ManifestEntry } from '@vault/shared'

export interface SyncDeltas {
  missingIds: ItemId[]
  upstreamIds: ItemId[]
  locallyTombstonedSnapshots: VaultDoc[]
  deletedLastModifiedUpdates: [ItemId, number][]
  deletedVersionUpdates?: [ItemId, number][]
  knownSet: Set<ItemId>
  tombstoneSet: Set<ItemId>
}

export interface CalculateSyncDeltasParams {
  manifest: ManifestEntry[]
  force: boolean
  knownItemIds: ItemId[]
  tombstoneItemIds: ItemId[]
  localLastModifiedMap: Map<ItemId, number>
  quarantinedMap: Map<ItemId, number>
  localVersionsMap: Map<ItemId, { baseVersion: number; isDirty: boolean }>
}

export interface CalculateInboundDeltasParams {
  manifest: ManifestEntry[]
  activeSet: Set<ItemId>
  tombstoneSet: Set<ItemId>
  knownSet: Set<ItemId>
  quarantinedMap: Map<ItemId, number>
  force: boolean
  localVersionsMap: Map<ItemId, { baseVersion: number; isDirty: boolean }>
}

export interface CalculateUpstreamDeltasParams {
  allLocalIds: Set<ItemId>
  missingSet: Set<ItemId>
  locallyTombstonedSet: Set<ItemId>
  tombstoneSet: Set<ItemId>
  serverManifestIds: Set<ItemId>
  serverDeletedSet: Set<ItemId>
  localVersionsMap: Map<ItemId, { baseVersion: number; isDirty: boolean }>
  quarantinedMap: Map<ItemId, number>
  force: boolean
}

export class ManifestDeltaCalculator {
  static calculateInboundDeltas(params: CalculateInboundDeltasParams) {
    const locallyTombstonedSnapshots: VaultDoc[] = []
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

      const baseVersion = params.localVersionsMap.get(id)?.baseVersion ?? 0

      if (isDeleted) {
        if (params.activeSet.has(id)) {
          // Item exists locally and is active, but the server manifest indicates it is deleted.
          // Apply tombstone locally and record timestamp to prevent resurrection.
          locallyTombstonedSnapshots.push({ id, deleted: true })
          deletedLastModifiedUpdates.push([id, serverTime])
          deletedVersionUpdates.push([id, serverVersion])
        } else if (serverVersion > baseVersion) {
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

      if (!params.knownSet.has(id) || serverVersion > baseVersion) {
        missingIds.push(id)
      }
    }

    return { missingIds, locallyTombstonedSnapshots, deletedLastModifiedUpdates, deletedVersionUpdates }
  }

  static calculateUpstreamDeltas(params: CalculateUpstreamDeltasParams): ItemId[] {
    const upstreamIds: ItemId[] = []
    for (const localId of params.allLocalIds) {
      if (params.missingSet.has(localId) || params.locallyTombstonedSet.has(localId)) continue
      // Quarantined items wait for manual recovery. Pushing them again would just fail and
      // quarantine them again on every manifest sync.
      if (!params.force && params.quarantinedMap.has(localId)) continue

      if (!params.serverManifestIds.has(localId)) {
        // Item exists locally but is completely missing from server manifest
        upstreamIds.push(localId)
      } else if (params.tombstoneSet.has(localId)) {
        // If tombstoned locally, push upstream ONLY if server still has an active snapshot
        if (!params.serverDeletedSet.has(localId)) {
          upstreamIds.push(localId)
        }
      } else if (params.localVersionsMap.get(localId)?.isDirty) {
        // Dirty items have local changes that need to be pushed upstream
        upstreamIds.push(localId)
      }
    }
    return upstreamIds
  }

  static calculateSyncDeltas(params: CalculateSyncDeltasParams): SyncDeltas {
    const activeSet = new Set(params.knownItemIds)
    const serverManifestIds = new Set<ItemId>(params.manifest.map(entry => entry.itemId))
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
      serverManifestIds,
      serverDeletedSet,
      localVersionsMap: params.localVersionsMap,
      quarantinedMap: params.quarantinedMap,
      force: params.force,
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
