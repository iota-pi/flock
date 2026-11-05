import type { ItemId, SyncLogEntry } from '@vault/shared'
import type { KeyProvider } from '../keys/Keyring'
import type { AutomergeDocStore } from './docStore'
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

export type ParkReason = 'decryption' | 'missingKey' | 'missingDeps' | 'apply'

/** A log entry that couldn't be applied yet. It keeps the row's ciphertext, so nothing is in the clear. */
export interface ParkedEntry extends Pick<SyncLogEntry, 'seq' | 'itemId' | 'encryptedMessage'> {
  reason: ParkReason
  parkedAt: number
  /** How many times the row has failed to decrypt */
  decryptionFailures: number
}

/** What the healer knows of an item it's working on */
interface HealingItem {
  /** When the item started waiting, for telling the user after a day */
  since: number
  attempts: number
  nextAttemptAt: number
  /** Whether the server's snapshot may hold what the item needs */
  needsSnapshot: boolean
}

export interface GapHealerDeps {
  db: SyncLogDatabase
  keys: KeyProvider
  docStore: Pick<AutomergeDocStore, 'getMissingDeps'>
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
        item.needsSnapshot = true
      }
    }
    this.reportHealing()
  }

  private track(itemId: ItemId, since = Date.now()): HealingItem {
    let item = this.items.get(itemId)
    if (!item) {
      item = { since, attempts: 0, nextAttemptAt: 0, needsSnapshot: false }
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
      item.needsSnapshot = true
      item.nextAttemptAt = 0
    }
    this.reportHealing()
  }

  /** Asks for an item's snapshot, for an indexed item with no local data */
  requestSnapshot(itemId: ItemId): void {
    const item = this.track(itemId)
    item.needsSnapshot = true
    item.nextAttemptAt = 0
    this.reportHealing()
    this.deps.onWorkDue()
  }

  /** A later entry for the item may be what it was waiting for */
  onLogEntry(itemId: ItemId): void {
    const item = this.items.get(itemId)
    if (item) item.nextAttemptAt = 0
  }

  /** A manifest sync may have merged what any item was waiting for */
  onManifestSynced(): void {
    this.retryAll()
  }

  onKeyringUpdated(): void {
    this.retryAll()
  }

  private retryAll(): void {
    if (this.items.size === 0) return
    for (const item of this.items.values()) {
      item.nextAttemptAt = 0
    }
    this.deps.onWorkDue()
  }

  /** Works on every item that's due. Throws if storage fails, leaving the rest for the next poll. */
  async runDue(signal?: AbortSignal): Promise<void> {
    const now = Date.now()
    const due = Array.from(this.items.entries()).filter(([, item]) => item.nextAttemptAt <= now)
    if (due.length === 0) return

    const needSnapshots = due.filter(([, item]) => item.needsSnapshot).map(([itemId]) => itemId)
    if (needSnapshots.length > 0) {
      await this.deps.fetchSnapshots(needSnapshots, signal)
    }

    const parked = await this.deps.db.getAll<ParkedEntry>(SYNC_LOG_STORES.parked)
    for (const [itemId, item] of due) {
      const entries = parked.filter(entry => entry.itemId === itemId).sort((a, b) => a.seq - b.seq)
      await this.healItem(itemId, item, entries)
    }
    this.reportHealing()
  }

  private async healItem(itemId: ItemId, item: HealingItem, entries: ParkedEntry[]): Promise<void> {
    const applied: number[] = []
    let isMissingDeps = false

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

    if (!isMissingDeps && await this.remainingEntries(itemId) === 0) {
      this.items.delete(itemId)
      await this.deps.recoveryManager.resolveQuarantines([itemId], MISSING_CHANGES_KINDS)
      return
    }

    item.attempts += 1
    item.nextAttemptAt = Date.now() + GAP_HEAL_DELAYS[Math.min(item.attempts - 1, GAP_HEAL_DELAYS.length - 1)]
    if (isMissingDeps && Date.now() - item.since >= SYNC_TIMEOUTS.missingChangesQuarantine) {
      await this.deps.recoveryManager.quarantine(itemId, 'missingChanges', 'Waiting for changes from another device')
    }
  }

  private async remainingEntries(itemId: ItemId): Promise<number> {
    const parked = await this.deps.db.getAll<ParkedEntry>(SYNC_LOG_STORES.parked)
    return parked.filter(entry => entry.itemId === itemId).length
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
