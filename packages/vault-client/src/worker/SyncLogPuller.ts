import { debounce } from 'lodash-es'
import type { ItemId, SyncLogEntry } from '@vault/shared'
import type { KeyProvider } from '../keys/Keyring'
import type { GapHealer, ParkReason } from './GapHealer'
import type { IncomingChanges } from './IncomingChanges'
import type { RealtimeBus } from './RealtimeBus'
import type { SnapshotCoverage } from './SnapshotCoverage'
import type { SyncSessionState } from './SyncSessionState'
import type { LogCursorStore } from './stores/LogCursorStore'
import type { LogPushResult } from './ChangeOutbox'
import { decryptWithKeyResolution } from './utils/decryptWithKeyResolution'
import { BoundedSet } from '../utils/BoundedSet'
import { classifySyncError } from '../utils/errorClassifier'
import { fireAndForget } from '../utils/fireAndForget'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'
import { createLogger } from '../utils/logger'

const log = createLogger('SyncLogPuller')

const OWN_PUSH_CACHE_MAX = 1000
const MAX_GAP_REPOLL_MS = 16_000

/** What `pollLog` returns for the log */
export interface LogPage {
  entries: SyncLogEntry[]
  hasMore: boolean
  serverNow: number
}

/** A missing seq this device is waiting for */
interface GapWait {
  seq: number
  /** The server's clock when the gap was first seen */
  firstSeenAt: number
  repolls: number
}

export interface SyncLogPullerDeps {
  cursorStore: Pick<LogCursorStore, 'load' | 'save'>
  keys: KeyProvider
  session: SyncSessionState
  incoming: Pick<IncomingChanges, 'apply'>
  healer: Pick<GapHealer, 'park' | 'onLogEntry'>
  coverage: Pick<SnapshotCoverage, 'recordPulledChanges' | 'onCursorAdvanced'>
  /** Tells the account's other tabs which items were pulled */
  bus?: Pick<RealtimeBus, 'publishSyncPing'>
  onKeyVersionMissing?: (kver: string) => void
  /** Called with an item once changes other devices pushed for it have been applied */
  onRemoteChangesApplied?: (itemId: ItemId) => void
  /** Reloads the rest of the state a new leader takes over */
  onLoad?: () => Promise<void>
}

/**
 * Reads the account's log in seq order. The cursor never moves past a missing seq while the row may
 * still be in flight, and an entry that can't be applied is parked rather than blocking the cursor.
 */
export class SyncLogPuller {
  private position = { cursor: 0, lastPullAt: null as number | null }
  private hasMore = false
  private gap: GapWait | null = null
  /** Whether this device may be behind the log's TTL, until a pull reaches the end of the log */
  private isCatchingUp = false
  /** Whether the manifest sync that goes with catching up has run */
  private hasCaughtUpManifest = false
  private manifestSyncDue = false
  private readonly ownSeqs = new BoundedSet<number>(OWN_PUSH_CACHE_MAX)
  private readonly addedChanges = new Set<ItemId>()

  // A pull that finishes after shutdown mustn't save, since shutdown may be clearing local data
  private readonly saveDebounced = debounce(() => {
    if (this.deps.session.isShutdown) return
    fireAndForget(this.save(), 'SyncLogPuller:save')
  }, 1000)

  constructor(private readonly deps: SyncLogPullerDeps) {}

  get cursor(): number {
    return this.position.cursor
  }

  /** Loads where the log was left, which an earlier leader may have moved */
  async loadState(): Promise<void> {
    if (this.deps.session.isShutdown) return
    try {
      const stored = await this.deps.cursorStore.load()
      this.position = {
        cursor: Math.max(this.position.cursor, stored.cursor),
        lastPullAt: Math.max(this.position.lastPullAt ?? 0, stored.lastPullAt ?? 0) || null,
      }
      await this.deps.onLoad?.()
    } catch (error) {
      log.error('Failed to load the log state', error)
    }
  }

  private async save(): Promise<void> {
    try {
      await this.deps.cursorStore.save(this.position)
    } catch (error) {
      log.error('Failed to save the log cursor', error)
    }
  }

  /** Saves the cursor, unless local data is being cleared. Called once, by the context's lifecycle. */
  async shutdown(options?: { clearLocalData?: boolean }): Promise<void> {
    this.saveDebounced.cancel()
    if (!options?.clearLocalData) {
      await this.save()
    }
    this.ownSeqs.clear()
    this.hasMore = false
    this.gap = null
  }

  /** Remembers this device's own rows, so that their echoes only advance the cursor */
  recordOwnPushes(results: LogPushResult[]): void {
    for (const { seq } of results) {
      this.ownSeqs.add(seq)
    }
  }

  /**
   * Whether a manifest sync has to run before this device reads the log. TTL may have removed rows it
   * never read, and the first visible row may still look contiguous. `now` is the server's clock
   * when it's known.
   */
  needsCatchUpManifest(now: number): boolean {
    if (this.hasCaughtUpManifest) return false
    const { lastPullAt } = this.position
    return lastPullAt === null || now - lastPullAt > SYNC_TIMEOUTS.logCatchUpAge
  }

  /** Records that the manifest sync ran, so the log can be read */
  onCatchUpManifestSynced(): void {
    this.hasCaughtUpManifest = true
    this.isCatchingUp = true
  }

  /** Takes the request for a manifest sync that a lost row left. The caller runs it. */
  takeManifestSyncRequest(): boolean {
    const isDue = this.manifestSyncDue
    this.manifestSyncDue = false
    return isDue
  }

  /** Only `hasMore` counts: waiting on a gap never polls at once (sync rule 4) */
  hasImmediatePendingPulls(): boolean {
    return this.hasMore && this.gap === null
  }

  /** How soon to poll again for a gap, if the log has one */
  get gapRepollDelay(): number | undefined {
    if (!this.gap) return undefined
    return Math.min(SYNC_TIMEOUTS.gapRepollBase * 2 ** this.gap.repolls, MAX_GAP_REPOLL_MS)
  }

  /** Applies a page of the log in seq order. Throws, leaving the cursor where it stopped, if storage fails. */
  async process(page: LogPage): Promise<void> {
    if (this.deps.session.isShutdown) return
    const entries = [...page.entries].sort((a, b) => a.seq - b.seq)
    const appliedItems = new Set<ItemId>()
    const timedOutKeys = new Set<string>()
    const start = { ...this.position }
    let stoppedAtGap = false

    try {
      for (const entry of entries) {
        if (entry.seq <= this.position.cursor) continue
        if (entry.seq !== this.position.cursor + 1 && !this.passGap(entry, page.serverNow)) {
          stoppedAtGap = true
          break
        }
        this.gap = null
        if (await this.handleEntry(entry, timedOutKeys)) {
          appliedItems.add(entry.itemId)
        }
        this.position.cursor = entry.seq
      }

      this.hasMore = page.hasMore
      if (!stoppedAtGap) {
        this.gap = null
        if (!page.hasMore) {
          this.position.lastPullAt = page.serverNow
          this.isCatchingUp = false
          this.hasCaughtUpManifest = false
        }
      }
    } finally {
      if (this.position.cursor !== start.cursor || this.position.lastPullAt !== start.lastPullAt) {
        this.saveDebounced()
      }
      if (appliedItems.size > 0) {
        this.deps.bus?.publishSyncPing(Array.from(appliedItems))
      }
    }

    await this.deps.coverage.recordPulledChanges(Array.from(this.addedChanges))
    this.addedChanges.clear()
    await this.deps.coverage.onCursorAdvanced(this.position.cursor)
  }

  /** Records that changes the doc lacked were applied, for snapshot coverage */
  onChangesAdded(itemId: ItemId): void {
    this.addedChanges.add(itemId)
  }

  /**
   * Decides about a missing seq before `entry`. A fresh gap may be a transaction not fully visible
   * yet, so it waits. A stale one moves the cursor past the gap and returns true.
   */
  private passGap(entry: SyncLogEntry, serverNow: number): boolean {
    const missingSeq = this.position.cursor + 1
    if (this.gap?.seq !== missingSeq) {
      this.gap = { seq: missingSeq, firstSeenAt: serverNow, repolls: 0 }
    } else {
      this.gap.repolls += 1
    }

    const isStale = serverNow - entry.createdAt >= SYNC_TIMEOUTS.gapWait
      || serverNow - this.gap.firstSeenAt >= SYNC_TIMEOUTS.gapWait
    if (!isStale) return false

    if (!this.isCatchingUp) {
      // Can't happen by design, so the manifest sync that recovers from it says something went wrong
      log.error(`Log rows ${missingSeq}-${entry.seq - 1} are missing; moving past them`)
      this.manifestSyncDue = true
    }
    this.position.cursor = entry.seq - 1
    return true
  }

  /** Returns whether the entry's changes reached its doc */
  private async handleEntry(entry: SyncLogEntry, timedOutKeys: Set<string>): Promise<boolean> {
    if (this.ownSeqs.has(entry.seq)) {
      this.ownSeqs.delete(entry.seq)
      return false
    }

    const { itemId } = entry
    let bytes: Uint8Array
    try {
      // Authentication is what rejects a damaged row: `loadIncremental` applies what it can of one
      bytes = await decryptWithKeyResolution(this.deps.keys, entry.encryptedMessage, {
        docId: itemId,
        timeoutMs: SYNC_TIMEOUTS.keyWait,
        timedOutKeys,
        onKeyVersionMissing: this.deps.onKeyVersionMissing,
      })
    } catch (error) {
      const classified = classifySyncError(error)
      if (classified.isTransientVault) throw error
      await this.park(entry, classified.isMissingKey ? 'missingKey' : 'decryption')
      return false
    }

    let applied: boolean
    try {
      applied = await this.deps.incoming.apply(itemId, bytes)
    } catch (error) {
      log.warn(`Couldn't apply log row ${entry.seq} to ${itemId}`, error)
      await this.park(entry, 'apply')
      return false
    }
    if (!applied) {
      await this.park(entry, 'missingDeps')
      return false
    }

    this.deps.healer.onLogEntry(itemId)
    this.deps.onRemoteChangesApplied?.(itemId)
    return true
  }

  private async park(entry: SyncLogEntry, reason: ParkReason): Promise<void> {
    await this.deps.healer.park(entry, reason)
  }
}
