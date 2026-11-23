import { debounce } from 'lodash-es'
import type { ItemId, SyncLogEntry } from '@vault/shared'
import type { KeyProvider } from '../keys/Keyring'
import type { GapHealer, ParkReason } from './GapHealer'
import type { IncomingChanges } from './IncomingChanges'
import type { RealtimeBus } from './RealtimeBus'
import type { AutomergeDocStore } from './docStore'
import type { SnapshotCoverage } from './SnapshotCoverage'
import type { SyncSessionState } from './SyncSessionState'
import type { LogCursorStore } from './stores/LogCursorStore'
import type { LogPushResult } from './ChangeOutbox'
import { decryptWithKeyResolution } from './utils/decryptWithKeyResolution'
import { AsyncMutex } from '../utils/AsyncMutex'
import { untilAborted } from '../utils/abort'
import { BoundedSet } from '../utils/BoundedSet'
import { classifySyncError } from '../utils/errorClassifier'
import { fireAndForget } from '../utils/fireAndForget'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'
import { createLogger } from '../utils/logger'
import {
  INITIAL_LOG_PULL_STATE,
  gapRepollDelay,
  hasImmediatePendingPulls,
  needsCatchUpManifest,
  pendingManifestSync,
  transitionLogPull,
  type LogPullEffect,
  type LogPullEvent,
  type LogPullState,
} from './logPullState'

const log = createLogger('SyncLogPuller')

const OWN_PUSH_CACHE_MAX = 1000

/** What `pollLog` returns for the log */
export interface LogPage {
  entries: SyncLogEntry[]
  hasMore: boolean
  serverNow: number
}

export interface SyncLogPullerDeps {
  cursorStore: Pick<LogCursorStore, 'load' | 'save'>
  /** Writes pulled docs to storage, which has to happen before the cursor moves past their rows */
  docs: Pick<AutomergeDocStore, 'flushToStorage'>
  keys: KeyProvider
  session: SyncSessionState
  incoming: Pick<IncomingChanges, 'apply'>
  healer: Pick<GapHealer, 'park' | 'onLogEntry'>
  coverage: Pick<SnapshotCoverage, 'recordPulledChanges'>
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
  /** Where reading stopped, and which manifest sync it waits for (`logPullState.ts`) */
  private state: LogPullState = INITIAL_LOG_PULL_STATE
  private readonly ownSeqs = new BoundedSet<number>(OWN_PUSH_CACHE_MAX)
  private readonly addedChanges = new Set<ItemId>()
  /** Items log rows were applied to that may not have reached storage under a saved cursor yet */
  private readonly unflushedItems = new Set<ItemId>()
  /** Saves run one at a time, so a slow flush can't let an older cursor overwrite a newer one */
  private readonly saveMutex = new AsyncMutex()
  /** Settles whenever the position or state changes, which may end a wait for catching up */
  private changed = Promise.withResolvers<void>()

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
      this.notifyChanged()
      await this.deps.onLoad?.()
    } catch (error) {
      log.error('Failed to load the log state', error)
    }
  }

  /**
   * Saves the cursor once the docs its rows were applied to are in storage (sync rule 1). If a doc
   * fails to save, the stored cursor stays behind, and those rows are pulled and applied again.
   */
  private async save(): Promise<void> {
    await this.saveMutex.runExclusive(async () => {
      // Taken together, so every row under this cursor was applied to one of these items
      const position = { ...this.position }
      const items = Array.from(this.unflushedItems)
      try {
        await this.deps.docs.flushToStorage(items)
      } catch (error) {
        log.error('Failed to store pulled docs; not saving the log cursor', error)
        return
      }
      for (const itemId of items) {
        this.unflushedItems.delete(itemId)
      }
      try {
        await this.deps.cursorStore.save(position)
      } catch (error) {
        log.error('Failed to save the log cursor', error)
      }
    })
  }

  /** Saves the cursor, unless local data is being cleared. Called once, by the context's lifecycle. */
  async shutdown(options?: { clearLocalData?: boolean }): Promise<void> {
    this.saveDebounced.cancel()
    if (options?.clearLocalData) {
      // A debounced save already running mustn't write while local data is cleared
      await this.saveMutex.waitForIdle()
    } else {
      await this.save()
    }
    this.ownSeqs.clear()
    this.unflushedItems.clear()
    this.dispatch({ type: 'stop' })
  }

  private dispatch(event: LogPullEvent): LogPullEffect[] {
    const { state, effects } = transitionLogPull(this.state, event)
    this.state = state
    this.notifyChanged()
    return effects
  }

  private notifyChanged(): void {
    this.changed.resolve()
    this.changed = Promise.withResolvers<void>()
  }

  /**
   * Whether this device has caught up, so that it holds what the server's snapshots hold: it has
   * read the log within its TTL, or catch-up's manifest sync has merged the snapshots. Until then, a
   * snapshot it uploads could replace one that holds more.
   */
  get isCaughtUp(): boolean {
    return !this.needsCatchUpManifest(Date.now())
  }

  /** Resolves once the device has caught up (see `isCaughtUp`), or rejects if `signal` aborts first */
  async whenCaughtUp(signal?: AbortSignal): Promise<void> {
    while (!this.isCaughtUp) {
      const { promise } = this.changed
      await (signal ? untilAborted(promise, signal) : promise)
    }
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
    return needsCatchUpManifest(this.state, this.position.lastPullAt, now)
  }

  /** Records that the server's clock showed the device is behind, so the page it got was dropped */
  onBehindSeen(): void {
    this.dispatch({ type: 'behindSeen' })
  }

  /** Records that catch-up's manifest sync fetched the manifest, so the log can be read */
  onCatchUpManifestSynced(): void {
    this.dispatch({ type: 'catchUpSynced' })
  }

  /** Records that the manifest sync a lost row asked for fetched the manifest */
  onRecoveryManifestSynced(): void {
    this.dispatch({ type: 'recoverySynced' })
  }

  /** The manifest sync the poller has to run, which stays due until one fetches the manifest */
  get pendingManifestSync(): 'catchUp' | 'recovery' | undefined {
    return pendingManifestSync(this.state)
  }

  /** Only more pages count: waiting on a gap never polls at once (sync rule 4) */
  hasImmediatePendingPulls(): boolean {
    return hasImmediatePendingPulls(this.state)
  }

  /** How soon to poll again for a gap, if the log has one */
  get gapRepollDelay(): number | undefined {
    return gapRepollDelay(this.state)
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
        this.dispatch({ type: 'rowRead' })
        if (await this.handleEntry(entry, timedOutKeys)) {
          appliedItems.add(entry.itemId)
          this.unflushedItems.add(entry.itemId)
        }
        this.position.cursor = entry.seq
      }

      this.dispatch({ type: 'pageRead', stoppedAtGap, hasMore: page.hasMore })
      if (!stoppedAtGap && !page.hasMore) {
        this.position.lastPullAt = page.serverNow
        this.notifyChanged()
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
  }

  /** Records that changes the doc lacked were applied, for snapshot coverage */
  onChangesAdded(itemId: ItemId): void {
    this.addedChanges.add(itemId)
  }

  /** Decides about a missing seq before `entry`, and returns whether the cursor moved past it */
  private passGap(entry: SyncLogEntry, serverNow: number): boolean {
    const missingSeq = this.position.cursor + 1
    const effects = this.dispatch({ type: 'gapFound', missingSeq, nextCreatedAt: entry.createdAt, serverNow })
    if (!effects.includes('passGap')) return false

    if (effects.includes('reportLostRows')) {
      // Can't happen by design, so the manifest sync that recovers from it says something went wrong
      log.error(`Log rows ${missingSeq}-${entry.seq - 1} are missing; moving past them`)
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
