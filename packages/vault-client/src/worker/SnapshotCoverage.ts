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

/** A snapshot that replaced another device's: its heads, and the log's head when it was written */
interface SnapshotRecheck {
  itemId: ItemId
  uploadedHeads: string[]
  logSeq: number
}

/** An item with pulled changes no snapshot has confirmed */
export interface UnconfirmedPull {
  itemId: ItemId
  firstSeenAt: number
}

export interface StoredSnapshotDetails {
  itemId: ItemId
  /** The version the server gave the snapshot */
  version: number
  /** The version this device knew the item at before the upload */
  baseVersion: number
  heads: string[] | undefined
  logSeq: number
}

export interface SnapshotCoverageDeps {
  db: SyncLogDatabase
  serverHeads: ServerHeads
  firstStartState: (itemId: ItemId) => FirstStartState | undefined
  isSnapshotOnly: (itemId: ItemId) => boolean
  /** The heads of an item's doc, or null when it can't be loaded */
  readDocHeads: (itemId: ItemId) => Promise<string[] | null>
  /** Asks for the item's snapshot to be uploaded again */
  requestUpload: (itemId: ItemId) => void
}

/**
 * Keeps each server snapshot a superset of every one it replaced, and every change in some snapshot.
 * Snapshot uploads stay unconditional and last-write-wins, so this is three rules on the client:
 *
 * - **S1, log before snapshot:** `check` lets a snapshot be built only when everything in it is
 *   already in the log.
 * - **S2, recheck after a version jump:** a snapshot that replaced one this device never saw is
 *   uploaded again, if needed, once the log has delivered what the replaced snapshot held.
 * - **S3, backstop at manifest sync:** a device holding changes newer than the server's snapshot
 *   uploads them if nobody else does. `ManifestSyncManager` runs the check, with the records here.
 */
export class SnapshotCoverage {
  private readonly rechecks = new Map<ItemId, SnapshotRecheck>()

  constructor(private readonly deps: SnapshotCoverageDeps) {}

  async load(): Promise<void> {
    const stored = await this.deps.db.getAll<SnapshotRecheck>(SYNC_LOG_STORES.snapshotRechecks)
    for (const recheck of stored) {
      this.rechecks.set(recheck.itemId, recheck)
    }
  }

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

  /** S2. A jump means another device wrote in between, and its snapshot is now gone. */
  async onSnapshotStored({ itemId, version, baseVersion, heads, logSeq }: StoredSnapshotDetails): Promise<void> {
    if (!heads || version <= baseVersion + 1) return
    const recheck: SnapshotRecheck = { itemId, uploadedHeads: heads, logSeq }
    this.rechecks.set(itemId, recheck)
    await this.deps.db.put(SYNC_LOG_STORES.snapshotRechecks, recheck)
  }

  /**
   * S2. Once the cursor reaches `logSeq`, the doc holds every change of the replaced snapshot: by S1
   * they were in the log before that snapshot was written, which came before this device's write.
   */
  async onCursorAdvanced(cursor: number): Promise<void> {
    for (const recheck of Array.from(this.rechecks.values())) {
      if (recheck.logSeq > cursor) continue
      const heads = await this.deps.readDocHeads(recheck.itemId)
      if (!heads) continue
      if (!areHeadsEqual(heads, recheck.uploadedHeads)) {
        this.deps.requestUpload(recheck.itemId)
      }
      this.rechecks.delete(recheck.itemId)
      await this.deps.db.delete(SYNC_LOG_STORES.snapshotRechecks, recheck.itemId)
    }
  }

  /** S3. Starts the day an item's author has to upload a snapshot of pulled changes. */
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

  /** S3. A snapshot's heads now contain these items' docs. */
  async confirmPulledChanges(itemIds: ItemId[]): Promise<void> {
    await this.deps.db.delete(SYNC_LOG_STORES.unconfirmedPulls, ...itemIds)
  }

  clear(): void {
    this.rechecks.clear()
  }
}
