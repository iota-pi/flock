import * as Automerge from '@automerge/automerge/slim'
import { mapWithConcurrency, type ItemId, type ManifestEntry } from '@vault/shared'
import type { KeyProvider } from '../keys/Keyring'
import type { AutomergeDocStore } from './docStore'
import type { QuarantinedItem } from './calculateSyncDeltas'
import { decryptSnapshotHeads } from './snapshotHeads'
import { checkAlive, isAbortError } from '../utils/abort'
import { SYNC_BATCH_SIZES } from '../shared/syncConfig'
import { createLogger } from '../utils/logger'

const log = createLogger('findSnapshotsCoveredLocally')

/** A server snapshot whose changes the local document already has */
export interface CoveredSnapshot {
  itemId: ItemId
  version: number
  heads: string[]
  /** The local document's heads, which differ from `heads` when it has changes the snapshot lacks */
  docHeads: string[]
  /** Whether the snapshot is newer than `baseVersion` */
  isNewer: boolean
}

export interface FindSnapshotsCoveredLocallyParams {
  manifest: ManifestEntry[]
  activeItemIds: ItemId[]
  tombstoneItemIds: ItemId[]
  quarantinedMap: Map<ItemId, QuarantinedItem>
  localVersionsMap: Map<ItemId, { baseVersion: number; isDirty: boolean }>
  /** Items with pulled changes no snapshot has confirmed, which are checked whatever their version */
  unconfirmedPulls: ReadonlyMap<ItemId, number>
  keys: KeyProvider
  docStore: Pick<AutomergeDocStore, 'findHandle'>
  signal: AbortSignal
  isAlive: () => boolean
}

function isNewerThanBase(entry: ManifestEntry, params: FindSnapshotsCoveredLocallyParams): boolean {
  const serverVersion = typeof entry.version === 'number' ? entry.version : 1
  return serverVersion > (params.localVersionsMap.get(entry.itemId)?.baseVersion ?? 0)
}

/**
 * Finds the server snapshots whose heads the local document already contains, among those newer than
 * this device's `baseVersion` (usually because the log delivered the same changes, so fetching them
 * would change nothing) and those of items with unconfirmed pulled changes. Anything that can't be
 * checked (no heads, a missing key, a document that isn't loaded) is left out, so it is fetched as
 * before.
 */
export async function findSnapshotsCoveredLocally(params: FindSnapshotsCoveredLocallyParams): Promise<CoveredSnapshot[]> {
  const active = new Set(params.activeItemIds)
  const tombstones = new Set(params.tombstoneItemIds)
  const candidates = params.manifest.filter(entry => {
    if (!entry.heads || entry.isDeleted) return false
    if (!active.has(entry.itemId) || tombstones.has(entry.itemId)) return false
    // Quarantined items go through recovery, which needs the snapshot itself
    if (params.quarantinedMap.has(entry.itemId)) return false
    return isNewerThanBase(entry, params) || params.unconfirmedPulls.has(entry.itemId)
  })

  const results = await mapWithConcurrency(candidates, SYNC_BATCH_SIZES.hydrationConcurrency, async entry => {
    checkAlive(params.signal, params.isAlive)
    try {
      const heads = await decryptSnapshotHeads(params.keys, entry.itemId, entry.heads!, { skipWait: true })
      checkAlive(params.signal, params.isAlive)
      const handle = await params.docStore.findHandle(entry.itemId)
      const doc = handle?.isReady() ? handle.doc() : undefined
      if (!doc || !Automerge.hasHeads(doc, heads)) return null
      return {
        itemId: entry.itemId,
        version: entry.version ?? 1,
        heads,
        docHeads: Automerge.getHeads(doc),
        isNewer: isNewerThanBase(entry, params),
      }
    } catch (error) {
      if (params.signal.aborted || isAbortError(error)) throw error
      log.debug(`Couldn't check snapshot heads for ${entry.itemId}, fetching it instead`, error)
      return null
    }
  })

  return results.filter(result => result !== null)
}
