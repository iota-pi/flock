import type { VaultDoc } from '../shared/types'
import type { ItemId, ManifestEntry } from '@vault/shared'

/** What a manifest sync knows about an item quarantined in manual recovery */
export interface QuarantinedItem {
  /**
   * The server version this device saw fail (e.g. a snapshot it couldn't decrypt). Absent for entries
   * stored before it was recorded and for quarantines that aren't tied to a server version.
   */
  serverVersion?: number
}

export interface SyncDeltas {
  missingIds: ItemId[]
  upstreamIds: ItemId[]
  locallyTombstonedSnapshots: VaultDoc[]
  deletedLastModifiedUpdates: [ItemId, number][]
  deletedVersionUpdates: [ItemId, number][]
  knownSet: Set<ItemId>
  tombstoneSet: Set<ItemId>
}

export interface CalculateSyncDeltasParams {
  manifest: ManifestEntry[]
  force: boolean
  knownItemIds: ItemId[]
  tombstoneItemIds: ItemId[]
  localLastModifiedMap: Map<ItemId, number>
  quarantinedMap: Map<ItemId, QuarantinedItem>
  localVersionsMap: Map<ItemId, { baseVersion: number; isDirty: boolean }>
}

/** The inputs both directions of reconciliation share */
interface DeltaContext
  extends Pick<CalculateSyncDeltasParams, 'manifest' | 'force' | 'quarantinedMap' | 'localVersionsMap'> {
  activeSet: Set<ItemId>
  tombstoneSet: Set<ItemId>
  /** Active and tombstoned items: everything this device has locally */
  knownSet: Set<ItemId>
}

function calculateInboundDeltas(ctx: DeltaContext) {
  const locallyTombstonedSnapshots: VaultDoc[] = []
  const deletedLastModifiedUpdates: [ItemId, number][] = []
  const deletedVersionUpdates: [ItemId, number][] = []
  const missingIds: ItemId[] = []

  for (const entry of ctx.manifest) {
    const id = entry.itemId
    if (!id) continue
    const serverTime = entry.modifiedAt ?? 0
    const serverVersion = typeof entry.version === 'number' ? entry.version : 1
    const isDeleted = entry.isDeleted

    const baseVersion = ctx.localVersionsMap.get(id)?.baseVersion ?? 0

    // If not forced and item is currently quarantined in manual recovery, skip it unless the server
    // has a newer version than the one that failed. Versions are server-assigned, so this doesn't
    // depend on this device's clock. A failed hydration doesn't advance `baseVersion`, so the version
    // recorded at quarantine time stops a failing snapshot being re-fetched on every sync; entries
    // without one fall back to `baseVersion`.
    const quarantined = ctx.quarantinedMap.get(id)
    if (!ctx.force && quarantined) {
      const failedVersion = Math.max(quarantined.serverVersion ?? 0, baseVersion)
      if (serverVersion <= failedVersion) {
        continue
      }
    }

    if (isDeleted) {
      if (ctx.activeSet.has(id)) {
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
    if (ctx.tombstoneSet.has(id)) {
      continue
    }

    // If the item was quarantined and not skipped above (either force is true or server has a newer version),
    // fetch it immediately to retry recovery.
    if (ctx.quarantinedMap.has(id)) {
      missingIds.push(id)
      continue
    }

    if (!ctx.knownSet.has(id) || serverVersion > baseVersion) {
      missingIds.push(id)
    }
  }

  return { missingIds, locallyTombstonedSnapshots, deletedLastModifiedUpdates, deletedVersionUpdates }
}

function calculateUpstreamDeltas(
  ctx: DeltaContext,
  inbound: Pick<SyncDeltas, 'missingIds' | 'locallyTombstonedSnapshots'>,
): ItemId[] {
  const serverManifestIds = new Set(ctx.manifest.map(entry => entry.itemId))
  const serverDeletedSet = new Set(
    ctx.manifest
      .filter(entry => entry.isDeleted === true)
      .map(entry => entry.itemId),
  )
  const missingSet = new Set(inbound.missingIds)
  const locallyTombstonedSet = new Set(inbound.locallyTombstonedSnapshots.map(s => s.id))

  const upstreamIds: ItemId[] = []
  for (const localId of ctx.knownSet) {
    if (missingSet.has(localId) || locallyTombstonedSet.has(localId)) continue
    // Quarantined items wait for manual recovery. Pushing them again would just fail and
    // quarantine them again on every manifest sync.
    if (!ctx.force && ctx.quarantinedMap.has(localId)) continue

    if (!serverManifestIds.has(localId)) {
      // Item exists locally but is completely missing from server manifest
      upstreamIds.push(localId)
    } else if (ctx.tombstoneSet.has(localId)) {
      // If tombstoned locally, push upstream ONLY if server still has an active snapshot
      if (!serverDeletedSet.has(localId)) {
        upstreamIds.push(localId)
      }
    } else if (ctx.localVersionsMap.get(localId)?.isDirty) {
      // Dirty items have local changes that need to be pushed upstream
      upstreamIds.push(localId)
    }
  }
  return upstreamIds
}

export function calculateSyncDeltas(params: CalculateSyncDeltasParams): SyncDeltas {
  const activeSet = new Set(params.knownItemIds)
  const tombstoneSet = new Set(params.tombstoneItemIds)
  for (const [id] of params.localLastModifiedMap) {
    if (!activeSet.has(id)) {
      tombstoneSet.add(id)
    }
  }
  const knownSet = new Set([...activeSet, ...tombstoneSet])

  const ctx: DeltaContext = {
    manifest: params.manifest,
    force: params.force,
    quarantinedMap: params.quarantinedMap,
    localVersionsMap: params.localVersionsMap,
    activeSet,
    tombstoneSet,
    knownSet,
  }

  const inbound = calculateInboundDeltas(ctx)

  // Two-Way Manifest Reconciliation (Upstream):
  // Identify local items that need to be pushed as snapshots to the server.
  // Exclude items that were just locally tombstoned.
  const upstreamIds = calculateUpstreamDeltas(ctx, inbound)

  return { ...inbound, upstreamIds, knownSet, tombstoneSet }
}
