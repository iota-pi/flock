import type { ItemId, SyncLogEntry } from '@vault/shared'
import type { KeyProvider } from '../keys/Keyring'
import type { AutomergeDocStore } from './docStore'
import type { AutomergeIndexManager } from './docStore/AutomergeIndexManager'
import type { IncomingChanges } from './IncomingChanges'
import type { RecoveryManager } from './RecoveryManager'
import type { SyncLogDatabase } from './stores/SyncLogDatabase'
import { decryptWithKeyResolution } from './utils/decryptWithKeyResolution'
import { SYNC_LOG_STORES } from '../shared/syncLogStorage'
import { GAP_HEAL_DELAYS, SYNC_TIMEOUTS } from '../shared/syncConfig'
import type { ManualRecoveryKind } from '../shared/manualRecoveryStore'
import { classifySyncError } from '../utils/errorClassifier'
import { createLogger } from '../utils/logger'

const log = createLogger('GapHealer')

/** Attempts at a row that won't decrypt before its item is quarantined and the row is dropped */
export const MAX_PULL_RETRIES = 5

const MISSING_CHANGES_KINDS: ReadonlySet<ManualRecoveryKind> = new Set(['missingChanges'])

/** The wait before the next try, after the given number of tries */
function gapHealDelay(tries: number): number {
  return GAP_HEAL_DELAYS[Math.min(tries - 1, GAP_HEAL_DELAYS.length - 1)]
}

export type ParkReason = 'decryption' | 'missingKey' | 'missingDeps' | 'apply'

/** A log entry that couldn't be applied yet. It keeps the row's ciphertext, so nothing is in the clear. */
export interface ParkedEntry extends Pick<SyncLogEntry, 'seq' | 'itemId' | 'encryptedMessage'> {
  reason: ParkReason
  parkedAt: number
  /** How many times the row has failed to decrypt */
  decryptionFailures: number
}

/** What applying an item's parked rows found */
interface HealOutcome {
  isMissingDeps: boolean
  applyFailed: boolean
}

/** What the healer knows of an item it's working on */
interface HealingItem {
  /** When the item started waiting, for telling the user after a day */
  since: number
  attempts: number
  nextAttemptAt: number
  /**
   * When the item next fetches the server's snapshot, which may hold what it needs. Undefined while
   * a snapshot can't help (rows parked only for their keys or decryption).
   *
   * Kept apart from `nextAttemptAt`: a later row makes the item due at once, but the server's snapshot
   * rarely changes between rows, since the author uploads one only every 15 min to 1 h. So the parked
   * rows are applied again at once, and the snapshot is fetched again only on its own backoff.
   */
  snapshotDueAt?: number
  /** Snapshot fetches since the item started waiting, for that backoff */
  fetches: number
}

export interface GapHealerDeps {
  db: SyncLogDatabase
  keys: KeyProvider
  docStore: Pick<AutomergeDocStore, 'getMissingDeps'>
  indexManager: Pick<AutomergeIndexManager, 'listTombstoneIds'>
  incoming: Pick<IncomingChanges, 'apply'>
  recoveryManager: Pick<RecoveryManager, 'quarantine' | 'reportDecryptionFailure' | 'resolveQuarantines'>
  /** Fetches items' snapshots and merges them into their docs */
  fetchSnapshots: (itemIds: ItemId[], signal?: AbortSignal) => Promise<void>
  /** Asks for a poll, which runs whatever is due */
  onWorkDue: () => void
  onKeyVersionMissing?: (kver: string) => void
  /** Called when whether anything waits to be healed changes */
  onHealingChange?: (isHealing: boolean) => void
}

/**
 * Owns the items that have parked entries or missing dependencies. It fetches an item's snapshot at
 * once, rather than at the next hourly manifest sync, and applies what was parked. If the server
 * doesn't have the dependencies yet, some device's doc still holds them, so it keeps trying.
 */
export class GapHealer {
  private readonly items = new Map<ItemId, HealingItem>()

  constructor(private readonly deps: GapHealerDeps) {}

  /** Picks up the items that parked entries were left for */
  async load(): Promise<void> {
    const parked = await this.deps.db.getAll<ParkedEntry>(SYNC_LOG_STORES.parked)
    for (const entry of parked) {
      const item = this.track(entry.itemId, entry.parkedAt)
      item.since = Math.min(item.since, entry.parkedAt)
      if (entry.reason === 'missingDeps' || entry.reason === 'apply') {
        item.snapshotDueAt = 0
      }
    }
    this.reportHealing()
  }

  private track(itemId: ItemId, since = Date.now()): HealingItem {
    let item = this.items.get(itemId)
    if (!item) {
      item = { since, attempts: 0, nextAttemptAt: 0, fetches: 0 }
      this.items.set(itemId, item)
    }
    return item
  }

  private reportHealing(): void {
    this.deps.onHealingChange?.(this.items.size > 0)
  }

  /** Keeps an entry that couldn't be applied, across reloads, and schedules its item */
  async park(entry: SyncLogEntry, reason: ParkReason): Promise<void> {
    const parked: ParkedEntry = {
      seq: entry.seq,
      itemId: entry.itemId,
      encryptedMessage: entry.encryptedMessage,
      reason,
      parkedAt: Date.now(),
      decryptionFailures: reason === 'decryption' ? 1 : 0,
    }
    await this.deps.db.put(SYNC_LOG_STORES.parked, parked)
    const item = this.track(entry.itemId)
    if (reason === 'missingDeps' || reason === 'apply') {
      // The first such row fetches the snapshot at once. Later ones wait for its backoff.
      item.snapshotDueAt ??= 0
      item.nextAttemptAt = 0
    }
    this.reportHealing()
  }

  /** Asks for an item's snapshot, for an indexed item with no local data */
  requestSnapshot(itemId: ItemId): void {
    const item = this.track(itemId)
    item.snapshotDueAt = 0
    item.nextAttemptAt = 0
    this.reportHealing()
    this.deps.onWorkDue()
  }

  /** A later entry for the item may be what it was waiting for. Its parked rows are applied again without a fetch. */
  onLogEntry(itemId: ItemId): void {
    const item = this.items.get(itemId)
    if (item) item.nextAttemptAt = 0
  }

  /**
   * A manifest sync may have merged what any item was waiting for. It fetched every snapshot newer
   * than this device's itself, so the items apply their rows again without fetching.
   */
  onManifestSynced(): void {
    this.retryAll(false)
  }

  /** A new key may open a parked row, or a snapshot that couldn't be read before */
  onKeyringUpdated(): void {
    this.retryAll(true)
  }

  private retryAll(refetchSnapshots: boolean): void {
    if (this.items.size === 0) return
    for (const item of this.items.values()) {
      item.nextAttemptAt = 0
      if (refetchSnapshots && item.snapshotDueAt !== undefined) item.snapshotDueAt = 0
    }
    this.deps.onWorkDue()
  }

  /** Works on every item that's due. Throws if storage fails, leaving the rest for the next poll. */
  async runDue(signal?: AbortSignal): Promise<void> {
    const now = Date.now()
    const isSnapshotDue = (item: HealingItem) => item.snapshotDueAt !== undefined && item.snapshotDueAt <= now
    const due = Array.from(this.items.entries()).filter(
      ([, item]) => item.nextAttemptAt <= now || isSnapshotDue(item),
    )
    if (due.length === 0) return

    const needSnapshots = due.filter(([, item]) => isSnapshotDue(item))
    if (needSnapshots.length > 0) {
      // A failed request throws, leaving the snapshots due for the next poll (rule 4)
      await this.deps.fetchSnapshots(needSnapshots.map(([itemId]) => itemId), signal)
      for (const [, item] of needSnapshots) {
        item.fetches += 1
        item.snapshotDueAt = now + gapHealDelay(item.fetches)
      }
    }

    const parked = await this.readParkedByItem()
    const tombstones = new Set(await this.deps.indexManager.listTombstoneIds())
    const healed: Array<[ItemId, HealingItem, HealOutcome]> = []
    for (const [itemId, item] of due) {
      const entries = parked.get(itemId) ?? []
      if (tombstones.has(itemId)) {
        await this.dropDeleted(itemId, entries)
        continue
      }
      healed.push([itemId, item, await this.healItem(itemId, entries)])
    }

    // Read again rather than counted from the first read, since a pull may have parked more meanwhile
    const remaining = healed.some(([, , outcome]) => !outcome.isMissingDeps) ? await this.readParkedByItem() : parked
    for (const [itemId, item, outcome] of healed) {
      await this.finishItem(itemId, item, outcome, remaining.has(itemId))
    }
    this.reportHealing()
  }

  /** Reads the parked rows once, grouped by item and in seq order */
  private async readParkedByItem(): Promise<Map<ItemId, ParkedEntry[]>> {
    const byItem = new Map<ItemId, ParkedEntry[]>()
    for (const entry of await this.deps.db.getAll<ParkedEntry>(SYNC_LOG_STORES.parked)) {
      const entries = byItem.get(entry.itemId)
      if (entries) {
        entries.push(entry)
      } else {
        byItem.set(entry.itemId, [entry])
      }
    }
    for (const entries of byItem.values()) {
      entries.sort((a, b) => a.seq - b.seq)
    }
    return byItem
  }

  /**
   * A deleted item needs none of its parked rows, since deletes are terminal, and what they depend
   * on may never come (say, its create row expired and the server's tombstone has no snapshot)
   */
  private async dropDeleted(itemId: ItemId, entries: ParkedEntry[]): Promise<void> {
    if (entries.length > 0) {
      await this.deps.db.delete(SYNC_LOG_STORES.parked, ...entries.map(entry => entry.seq))
    }
    this.items.delete(itemId)
    await this.deps.recoveryManager.resolveQuarantines([itemId], MISSING_CHANGES_KINDS)
  }

  /** Applies an item's parked rows, deleting the applied ones once nothing is missing */
  private async healItem(itemId: ItemId, entries: ParkedEntry[]): Promise<HealOutcome> {
    const applied: number[] = []
    let isMissingDeps = false
    let applyFailed = false

    for (const entry of entries) {
      const bytes = await this.decrypt(entry)
      if (!bytes) continue
      try {
        if (await this.deps.incoming.apply(itemId, bytes)) {
          applied.push(entry.seq)
        } else {
          isMissingDeps = true
        }
      } catch (error) {
        log.warn(`Couldn't apply parked row ${entry.seq} to ${itemId}`, error)
        applyFailed = true
      }
    }

    if ((await this.deps.docStore.getMissingDeps(itemId)).length > 0) {
      isMissingDeps = true
    }

    // Kept until nothing is missing: applying a row again changes nothing, and the doc's own queue of
    // changes with missing dependencies may not reach storage
    if (!isMissingDeps) {
      await this.deps.db.delete(SYNC_LOG_STORES.parked, ...applied)
    }
    return { isMissingDeps, applyFailed }
  }

  /** Stops tracking a healed item, or schedules its next attempt and tells the user after a day */
  private async finishItem(
    itemId: ItemId,
    item: HealingItem,
    { isMissingDeps, applyFailed }: HealOutcome,
    hasParkedRows: boolean,
  ): Promise<void> {
    if (!isMissingDeps && !hasParkedRows) {
      this.items.delete(itemId)
      await this.deps.recoveryManager.resolveQuarantines([itemId], MISSING_CHANGES_KINDS)
      return
    }

    item.attempts += 1
    item.nextAttemptAt = Date.now() + gapHealDelay(item.attempts)
    // A row that won't apply (say, to a doc in storage that won't load) is kept like a missing dependency,
    // since nothing is reset without the user, and gets the same day before the user is told
    if ((isMissingDeps || applyFailed) && Date.now() - item.since >= SYNC_TIMEOUTS.missingChangesQuarantine) {
      const code = applyFailed ? 'changesWontApply' : 'waitingForChanges'
      await this.deps.recoveryManager.quarantine(itemId, 'missingChanges', { code })
    }
  }

  /** Decrypts a parked row. Returns null when it can't be yet, and drops it once it never will be. */
  private async decrypt(entry: ParkedEntry): Promise<Uint8Array | null> {
    try {
      return await decryptWithKeyResolution(this.deps.keys, entry.encryptedMessage, {
        docId: entry.itemId,
        skipWait: true,
      })
    } catch (error) {
      const classified = classifySyncError(error)
      if (classified.isMissingKey || classified.isTransientVault) {
        if (classified.isMissingKey && classified.kver) this.deps.onKeyVersionMissing?.(classified.kver)
        return null
      }
      await this.recordDecryptionFailure(entry, error)
      return null
    }
  }

  private async recordDecryptionFailure(entry: ParkedEntry, error: unknown): Promise<void> {
    const decryptionFailures = entry.decryptionFailures + 1
    if (decryptionFailures < MAX_PULL_RETRIES) {
      await this.deps.db.put(SYNC_LOG_STORES.parked, { ...entry, decryptionFailures })
      return
    }
    await this.deps.db.delete(SYNC_LOG_STORES.parked, entry.seq)
    await this.deps.recoveryManager.reportDecryptionFailure(entry.itemId, 'pullDecryption', error)
  }
}
