import * as Automerge from '@automerge/automerge/slim'
import type { ItemId } from '@vault/shared'
import type { ItemSyncState } from './ItemSyncState'
import type { FirstStartState } from './FirstStart'
import { areHeadsEqual } from './utils/automerge'

/** Whether an item's snapshot may be built now, and if not, why */
export type CoverageCheck =
  | { covered: true }
  | { covered: false; reason: 'unpushed' | 'awaitingHeads' }

export interface SnapshotCoverageDeps {
  itemSyncState: Pick<ItemSyncState, 'getServerHeads' | 'isSnapshotOnly'>
  firstStartState: (itemId: ItemId) => FirstStartState | undefined
}

/**
 * Keeps each server snapshot a superset of every one it replaced, and every change in some snapshot.
 * Snapshot uploads stay unconditional and last-write-wins, so this is two rules on the client:
 *
 * - **S1, log before snapshot:** `check` lets a snapshot be built only when everything in it is
 *   already in the log.
 * - **S2, backstop at manifest sync:** a device holding changes newer than the server's snapshot
 *   uploads them if nobody else does. `ManifestSyncManager` runs the check, with the unconfirmed
 *   pulls `ItemSyncState` keeps.
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
    if (firstStart === 'awaitingSnapshot' || this.deps.itemSyncState.isSnapshotOnly(itemId)) return { covered: true }

    const serverHeads = this.deps.itemSyncState.getServerHeads(itemId)
    if (areHeadsEqual(Automerge.getHeads(doc), serverHeads)) return { covered: true }
    const since = Automerge.hasHeads(doc, serverHeads) ? serverHeads : []
    return Automerge.getChangesSince(doc, since).length === 0
      ? { covered: true }
      : { covered: false, reason: 'unpushed' }
  }
}
