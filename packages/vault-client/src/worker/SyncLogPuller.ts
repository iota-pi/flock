import { debounce } from 'lodash-es'
import type { ItemId, SyncLogEntry } from '@vault/shared'
import type { KeyProvider } from '../keys/Keyring'
import type { ItemReconciler, ParkReason } from './ItemReconciler'
import type { IncomingChanges } from './IncomingChanges'
import type { AutomergeDocStore } from './docStore'
import type { ItemSyncState } from './ItemSyncState'
import type { SyncSessionState } from './SyncSessionState'
import type { LogCursorStore } from './stores/LogCursorStore'
import type { LogPushResult } from './ChangeOutbox'
import type { ManifestAsk, ManifestAskOptions } from './ManifestSyncManager'
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
  isBehindLog,
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
  /** Applies rows, records which docs gained changes for snapshot coverage, and indexes the items they were applied to */
  incoming: Pick<IncomingChanges, 'apply' | 'readPending' | 'takeAddedChanges' | 'indexApplied'>
  reconciler: Pick<ItemReconciler, 'park' | 'onLogEntry'>
  /** Asks for the manifest syncs catching up and recovering lost rows need (`ManifestSyncManager.ask`) */
  askManifest: (options: ManifestAskOptions) => ManifestAsk
  /** Records pulled changes for snapshot coverage's S2, which has to be stored before the cursor moves past their rows */
  itemSyncState: Pick<ItemSyncState, 'recordPulledChanges' | 'save'>
  onKeyVersionMissing?: (kver: string) => void
  /** Called once a page with the items it applied changes other devices pushed to */
  onRemoteChangesApplied?: (itemIds: ItemId[]) => void
  /** Loads the rest of the state the session syncs from */
  onLoad?: () => Promise<void>
}

/** What the rows of one page share */
interface PageContext {
  timedOutKeys: Set<string>
  pending?: ReadonlySet<ItemId>
}

/**
 * Reads the account's log in seq order. The cursor never moves past a missing seq while the row may
 * still be in flight, and an entry that can't be applied is parked rather than blocking the cursor.
 */
export class SyncLogPuller {
  private position = { cursor: 0, lastPullAt: null as number | null }
  /** Where reading stopped, and whether it's catching up (`logPullState.ts`) */
  private state: LogPullState = INITIAL_LOG_PULL_STATE
  private readonly ownSeqs = new BoundedSet<number>(OWN_PUSH_CACHE_MAX)
  /**
   * Items log rows were applied to, or this device's own rows echoed for, that may not have reached
   * storage under a saved cursor yet
   */
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

  /**
   * Catch-up's manifest sync while it's asked for, which runs before the log is read again. It merges
   * the server's snapshots, which hold what rows TTL removed.
   */
  private catchUpAsk: ManifestAsk | undefined
  /** The manifest sync that recovers what lost rows held while it's asked for, which runs after the log is read */
  private recoveryAsk: ManifestAsk | undefined

  constructor(private readonly deps: SyncLogPullerDeps) {}

  get cursor(): number {
    return this.position.cursor
  }

  /**
   * Loads where the log was left, which an earlier session may have moved, and the rest of the state
   * (`onLoad`). Each is loaded even if the other fails.
   */
  async loadState(): Promise<void> {
    if (this.deps.session.isShutdown) return
    try {
      const stored = await this.deps.cursorStore.load()
      this.position = {
        cursor: Math.max(this.position.cursor, stored.cursor),
        lastPullAt: Math.max(this.position.lastPullAt ?? 0, stored.lastPullAt ?? 0) || null,
      }
      this.notifyChanged()
    } catch (error) {
      log.error('Failed to load the log cursor', error)
    }
    try {
      await this.deps.onLoad?.()
    } catch (error) {
      log.error('Failed to load the log state', error)
    }
  }

  /**
   * Saves the cursor once the docs its rows were applied to are in storage (sync rule 1), and the
   * `pulledAt` S2 records for them. If either fails to save, the stored cursor stays behind, and those
   * rows are pulled and applied again.
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
        await this.deps.itemSyncState.save()
      } catch (error) {
        log.error('Failed to store pulled changes for snapshot coverage; not saving the log cursor', error)
        return
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
   * Whether a manifest sync has to run before this device reads the log: catch-up's is asked for, or
   * the device may be behind the log's TTL (`isBehindLog`). `now` is the server's clock when it's known.
   */
  needsCatchUpManifest(now: number): boolean {
    return this.isCatchUpAsked || isBehindLog(this.state, this.position.lastPullAt, now)
  }

  /** Whether catch-up's manifest sync is asked for and no sync has fetched the manifest since */
  get isCatchUpAsked(): boolean {
    return this.catchUpAsk?.isOpen ?? false
  }

  /** Whether recovering lost rows' manifest sync is asked for and no sync has fetched the manifest since */
  get isRecoveryAsked(): boolean {
    return this.recoveryAsk?.isOpen ?? false
  }

  /** Asks for catch-up's manifest sync if this device needs one before reading the log, and returns whether it does */
  askCatchUpIfBehind(now: number): boolean {
    if (!this.needsCatchUpManifest(now)) return false
    if (!this.isCatchUpAsked) {
      this.catchUpAsk = this.deps.askManifest({
        mode: 'now',
        until: 'fetched',
        beforeRead: true,
        purpose: 'Catching up',
        onMet: () => this.dispatch({ type: 'catchUpSynced' }),
      })
    }
    return true
  }

  /**
   * Drops a page this device can't read yet, since the server's clock shows it may be behind, and
   * returns whether it did. Catch-up's manifest sync runs, and then the log is read again at once.
   */
  dropPageIfBehind(page: LogPage): boolean {
    if (!this.askCatchUpIfBehind(page.serverNow)) return false
    this.dispatch({ type: 'pageDropped' })
    return true
  }

  /** Only more pages count: waiting on a gap never polls at once (sync rule 4) */
  hasImmediatePendingPulls(): boolean {
    return hasImmediatePendingPulls(this.state)
  }

  /** How soon to poll again for a gap, if the log has one */
  get gapRepollDelay(): number | undefined {
    return gapRepollDelay(this.state)
  }

  /**
   * Applies a page of the log in seq order, then stores the docs it changed and indexes them. Throws,
   * leaving the cursor where it stopped, if storage fails.
   */
  async process(page: LogPage): Promise<void> {
    if (this.deps.session.isShutdown) return
    const entries = [...page.entries].sort((a, b) => a.seq - b.seq)
    const appliedItems = new Set<ItemId>()
    // One page shares a read of the pending marks, taken when its first row is applied
    const context: PageContext = { timedOutKeys: new Set<string>() }
    const start = { ...this.position }
    let stoppedAtGap = false
    let recording: Promise<void>

    try {
      for (const entry of entries) {
        if (entry.seq <= this.position.cursor) continue
        if (entry.seq !== this.position.cursor + 1 && !this.passGap(entry, page.serverNow)) {
          stoppedAtGap = true
          break
        }
        this.dispatch({ type: 'rowRead' })
        if (this.ownSeqs.delete(entry.seq)) {
          // The push read the changes from the doc in memory. If storing it failed, this row is what
          // brings them back after a crash, so the cursor waits for the doc as for a pulled row.
          this.unflushedItems.add(entry.itemId)
        } else if (await this.handleEntry(entry, context)) {
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
      // Sets `pulledAt` before the cursor can be saved past these rows, and `save` stores it first. If
      // the page failed, that error is the one thrown, and the next save stores the records.
      recording = this.deps.itemSyncState.recordPulledChanges(this.deps.incoming.takeAddedChanges())
      recording.catch(() => {})
      if (this.position.cursor !== start.cursor || this.position.lastPullAt !== start.lastPullAt) {
        this.saveDebounced()
      }
      if (appliedItems.size > 0) {
        const items = Array.from(appliedItems)
        this.deps.onRemoteChangesApplied?.(items)
      }
    }

    await recording
    // Stored before indexed, and not once shutdown may be clearing local data
    if (!this.deps.session.isShutdown) {
      await this.deps.incoming.indexApplied()
    }
  }

  /** Decides about a missing seq before `entry`, and returns whether the cursor moved past it */
  private passGap(entry: SyncLogEntry, serverNow: number): boolean {
    const missingSeq = this.position.cursor + 1
    const effects = this.dispatch({ type: 'gapFound', missingSeq, nextCreatedAt: entry.createdAt, serverNow })
    if (!effects.includes('passGap')) return false

    if (effects.includes('recoverLostRows')) {
      // Can't happen by design, so the manifest sync that recovers from it says something went wrong
      log.error(`Log rows ${missingSeq}-${entry.seq - 1} are missing; moving past them`)
      if (!this.isRecoveryAsked) {
        this.recoveryAsk = this.deps.askManifest({ mode: 'now', until: 'fetched', purpose: 'Recovering lost log rows' })
      }
    }
    this.position.cursor = entry.seq - 1
    return true
  }

  /** Returns whether the entry's changes reached its doc */
  private async handleEntry(entry: SyncLogEntry, context: PageContext): Promise<boolean> {
    const { itemId } = entry
    let bytes: Uint8Array
    try {
      // Authentication is what rejects a damaged row: `loadIncremental` applies what it can of one
      bytes = await decryptWithKeyResolution(this.deps.keys, entry.encryptedMessage, {
        docId: itemId,
        timeoutMs: SYNC_TIMEOUTS.keyWait,
        timedOutKeys: context.timedOutKeys,
        onKeyVersionMissing: this.deps.onKeyVersionMissing,
      })
    } catch (error) {
      const classified = classifySyncError(error)
      if (classified.isTransientVault) throw error
      await this.park(entry, classified.isMissingKey ? 'missingKey' : 'decryption')
      return false
    }

    // Outside the try: failing to read the marks is a storage failure, which fails the page rather than parking rows
    context.pending ??= await this.deps.incoming.readPending()
    let applied: boolean
    try {
      applied = await this.deps.incoming.apply(itemId, bytes, context.pending)
    } catch (error) {
      log.warn(`Couldn't apply log row ${entry.seq} to ${itemId}`, error)
      await this.park(entry, 'apply')
      return false
    }
    if (!applied) {
      await this.park(entry, 'missingDeps')
      return false
    }

    this.deps.reconciler.onLogEntry(itemId)
    return true
  }

  private async park(entry: SyncLogEntry, reason: ParkReason): Promise<void> {
    await this.deps.reconciler.park(entry, reason)
  }
}
