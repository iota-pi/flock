import * as Automerge from '@automerge/automerge/slim'
import type { ItemId } from '@vault/shared'
import type { ServerHeads } from './ServerHeads'
import type { SyncLogDatabase } from './stores/SyncLogDatabase'
import type { FirstStartState } from './FirstStart'
import { areHeadsEqual } from './utils/automerge'
import { SYNC_LOG_STORES } from '../shared/syncLogStorage'

/** Whether an item's snapshot may be built now, and if not, why */
export type CoverageCheck =
  | { covered: true }
  | { covered: false; reason: 'unpushed' | 'awaitingHeads' }

/** An item with pulled changes no snapshot has confirmed */
export interface UnconfirmedPull {
  itemId: ItemId
  firstSeenAt: number
}

export interface SnapshotCoverageDeps {
  db: SyncLogDatabase
  serverHeads: ServerHeads
  firstStartState: (itemId: ItemId) => FirstStartState | undefined
  isSnapshotOnly: (itemId: ItemId) => boolean
}

/**
 * Keeps each server snapshot a superset of every one it replaced, and every change in some snapshot.
 * Snapshot uploads stay unconditional and last-write-wins, so this is two rules on the client:
 *
 * - **S1, log before snapshot:** `check` lets a snapshot be built only when everything in it is
 *   already in the log.
 * - **S2, backstop at manifest sync:** a device holding changes newer than the server's snapshot
 *   uploads them if nobody else does. `ManifestSyncManager` runs the check, with the records here.
 */
export class SnapshotCoverage {
  constructor(private readonly deps: SnapshotCoverageDeps) {}

  /**
   * S1. Synchronous, so that a caller can run it in the same section as `Automerge.save`. The two
   * exceptions have no log to wait for: a change too large for a row, and an item at first start
   * whose server heads can't be known.
   */
  check(itemId: ItemId, doc: Automerge.Doc<unknown>): CoverageCheck {
    const firstStart = this.deps.firstStartState(itemId)
    if (firstStart === 'awaitingHeads') return { covered: false, reason: 'awaitingHeads' }
    if (firstStart === 'awaitingSnapshot' || this.deps.isSnapshotOnly(itemId)) return { covered: true }

    const serverHeads = this.deps.serverHeads.get(itemId)
    if (areHeadsEqual(Automerge.getHeads(doc), serverHeads)) return { covered: true }
    const since = Automerge.hasHeads(doc, serverHeads) ? serverHeads : []
    return Automerge.getChangesSince(doc, since).length === 0
      ? { covered: true }
      : { covered: false, reason: 'unpushed' }
  }

  /** S2. Starts the day an item's author has to upload a snapshot of pulled changes. */
  async recordPulledChanges(itemIds: ItemId[]): Promise<void> {
    const firstSeenAt = Date.now()
    for (const itemId of itemIds) {
      await this.deps.db.putIfAbsent(SYNC_LOG_STORES.unconfirmedPulls, itemId, { itemId, firstSeenAt })
    }
  }

  async listUnconfirmedPulls(): Promise<Map<ItemId, number>> {
    const records = await this.deps.db.getAll<UnconfirmedPull>(SYNC_LOG_STORES.unconfirmedPulls)
    return new Map(records.map(record => [record.itemId, record.firstSeenAt]))
  }

  /** S2. A snapshot's heads now contain these items' docs. */
  async confirmPulledChanges(itemIds: ItemId[]): Promise<void> {
    await this.deps.db.delete(SYNC_LOG_STORES.unconfirmedPulls, ...itemIds)
  }
}
