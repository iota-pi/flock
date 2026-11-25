import type { AutomergeIndexManager } from './docStore/AutomergeIndexManager'
import { buildAfterPush, estimateSnapshotSize, type SnapshotBuilder } from './SnapshotBuilder'
import type { RecoveryManager } from './RecoveryManager'
import type { SyncApiClient } from './SyncApiClient'
import { uploadSnapshotBatch, type StoredSnapshotRecorder, type UploadableSnapshot } from './snapshotUpload'
import { classifySyncError, isRequestFailure } from '../utils/errorClassifier'
import { isClientOutdatedError } from '@vault/shared'
import type { SyncLogPuller } from './SyncLogPuller'
import { AbortError, checkAlive, isAbortError, untilAborted, withTimeout } from '../utils/abort'
import { errorMessage } from '../utils/errorMessage'
import {
  SizeAwareBatchAccumulator,
  DEFAULT_MAX_BATCH_BYTES,
} from '../utils/SizeAwareBatchAccumulator'
import { fireAndForget } from '../utils/fireAndForget'
import type { ItemId } from '@vault/shared'
import type { ReencryptOptions, ReencryptResult, ReencryptStage } from '../shared/types'
import type { ManualRecoveryStage } from '../shared/manualRecoveryStore'
import { ReencryptionWaitError } from '../shared/reencryptionWaitError'
import { SYNC_BATCH_SIZES } from '../shared/syncConfig'
import { createLogger } from '../utils/logger'
import type { SyncSessionState } from './SyncSessionState'

const log = createLogger('SnapshotRewriter')

/** How many times an item is built and uploaded before the pass gives up on it */
export const MAX_REWRITE_ATTEMPTS = 3
const REWRITE_CHUNK_SIZE = SYNC_BATCH_SIZES.reencryptChunk

type FailedItem = ReencryptResult['failed'][number]

/** One call's options for `SnapshotRewriter.request` */
export interface RewriteRequestOptions extends ReencryptOptions {
  onProgress?: (done: number, total: number) => void
  /** Stops this caller waiting. The rewrite goes on for any other caller; `cancel` stops it. */
  signal?: AbortSignal
}

export interface SnapshotRewriterOptions {
  accountId: string
  builder: Pick<SnapshotBuilder, 'build'>
  indexManager: Pick<AutomergeIndexManager, 'listItemIds'>
  apiClient: SyncApiClient
  recoveryManager: RecoveryManager
  /** Rewrites run in the leader's polls, while online */
  session: SyncSessionState
  /** Makes this tab the leader, which polls */
  claimLeader: () => void
  /**
   * Whether catch-up's manifest sync has merged the server's snapshots. A rewrite before then could
   * replace a snapshot with one that lacks what only that snapshot holds.
   */
  catchUp: Pick<SyncLogPuller, 'isCaughtUp' | 'whenCaughtUp'>
  /** Runs a poll now, or right after the one in flight, resolving once it has finished */
  runPollNow: () => Promise<void>
  /** Called whenever the rewrite's stage changes, and with null once it stops */
  onStage?: (stage: ReencryptStage | null) => void
  /** Pushes items' changes to the log, which comes before their snapshots */
  pushToLog: (itemIds: ItemId[], signal?: AbortSignal) => Promise<void>
  maxBatchBytes?: number
  /**
   * Records the snapshots the server stored, as the snapshot pusher does. Otherwise the next manifest
   * sync would take the new versions for remote changes and fetch every item.
   */
  recorder?: StoredSnapshotRecorder
}

interface QueuedItem {
  itemId: ItemId
  attempts: number
}

interface Waiter {
  resolve: (result: ReencryptResult) => void
  reject: (error: unknown) => void
  onProgress?: (done: number, total: number) => void
  settled: boolean
}

/** A rewrite of every item, and the callers waiting for it */
interface Pass {
  result: ReencryptResult
  total: number
  done: number
  waiters: Set<Waiter>
  /** Aborted when the pass is cancelled or replaced, stopping the chunk in flight */
  controller: AbortController
}

/**
 * Rewrites every item's snapshot, re-encrypting it under the active data key. A request queues every
 * item and asks for a poll; the poll's rewrite phase (`runDue`, after the snapshot phase) builds and
 * uploads them, so rewrites share the poll's leadership, abort, auth pause and backoff (sync rule 4).
 * A request failure fails the poll and the callers waiting, and leaves the rest of the queue for the
 * next poll.
 */
export class SnapshotRewriter {
  private readonly maxBatchBytes: number
  /** One for each request or `prepare` waiting for leadership or catch-up, which `cancel` aborts */
  private readonly cancellers = new Set<AbortController>()
  private queue: QueuedItem[] = []
  private pass: Pass | null = null
  private currentStage: ReencryptStage | null = null

  constructor(private readonly deps: SnapshotRewriterOptions) {
    this.maxBatchBytes = deps.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES
  }

  /** What the rewrite is doing, or null when none is waiting or queued */
  get stage(): ReencryptStage | null {
    return this.currentStage
  }

  /** How many items the rewrite still has to upload */
  get pendingCount(): number {
    return this.queue.length
  }

  /**
   * Stops the rewrite: a request still waiting has changed nothing, and a pass in flight stops after
   * the request it's making, leaving the rest unwritten. Every caller waiting is rejected.
   */
  cancel(): void {
    const error = new AbortError('Re-encryption cancelled')
    for (const canceller of this.cancellers) {
      canceller.abort(error)
    }
    const pass = this.pass
    this.pass = null
    this.queue = []
    if (pass) {
      pass.controller.abort(error)
      this.rejectWaiters(pass, error)
    }
    this.setStage(null)
  }

  /**
   * Waits until a rewrite could run, as `request` does first, without rewriting anything. A caller
   * that has to change something before the rewrite (such as rotating the key) calls this first, so
   * that a device that can't push stops before that change.
   */
  async prepare(options: ReencryptOptions & { signal?: AbortSignal } = {}): Promise<void> {
    try {
      await this.waitUntilRewritesCanRun(options.signal, options.waitTimeoutMs)
    } finally {
      this.restoreStage()
    }
  }

  /**
   * Rewrites every item, resolving with what was rewritten once the poll that does it has finished.
   * A request made while another is under way starts the pass again over every item (a key may have
   * rotated since), and both callers get its result.
   */
  async request(options: RewriteRequestOptions = {}): Promise<ReencryptResult> {
    const { onProgress, signal } = options
    checkAlive(signal, true, 'Re-encryption aborted')
    if (!this.deps.session.isOnline) {
      throw new Error('Re-encryption aborted: network error (offline)')
    }
    if (!await this.deps.apiClient.getValidToken()) {
      throw new Error('No active session token available')
    }

    let itemIds: ItemId[]
    try {
      await this.waitUntilRewritesCanRun(signal, options.waitTimeoutMs)
      itemIds = await this.deps.indexManager.listItemIds()
      checkAlive(signal, true, 'Re-encryption aborted')
    } catch (error) {
      this.restoreStage()
      throw error
    }
    const pass = this.startPass(itemIds)

    const waiter: Waiter = { resolve: () => {}, reject: () => {}, onProgress, settled: false }
    const settledPromise = new Promise<ReencryptResult>((resolve, reject) => {
      waiter.resolve = resolve
      waiter.reject = reject
    })
    pass.waiters.add(waiter)

    if (itemIds.length === 0) {
      this.finishPass(pass)
    } else {
      fireAndForget(
        this.deps.runPollNow().finally(() => {
          // No poll can run (another tab leads, it went offline, it stopped). Otherwise a poll
          // that stops or fails rejects the waiters itself (`onPollStopped`).
          if (!waiter.settled && !this.deps.session.isOperational) {
            this.settle(waiter, () => waiter.reject(new Error(
              'Re-encryption could not run: sync stopped before it finished. It will go on when sync resumes.',
            )))
            this.pass?.waiters.delete(waiter)
          }
        }),
        'SnapshotRewriter:runPollNow',
      )
    }

    if (!signal) return settledPromise
    return untilAborted(settledPromise, signal).catch(error => {
      if (signal.aborted) {
        waiter.settled = true
        this.pass?.waiters.delete(waiter)
      }
      throw error
    })
  }

  /**
   * The poll's rewrite phase: uploads the queued items' snapshots. Skips the poll until the device
   * has caught up, as the snapshot phase does. Throws if a request fails, rejecting the callers
   * waiting, so the poll fails (sync rule 4) and the next one goes on with what's left.
   */
  async runDue(signal: AbortSignal): Promise<void> {
    while (this.pass && this.queue.length > 0) {
      if (!this.deps.session.isOperational || !this.deps.catchUp.isCaughtUp) return
      const pass = this.pass
      try {
        await this.runPass(pass, AbortSignal.any([signal, pass.controller.signal]))
      } catch (error) {
        // Cancelled or replaced, which isn't the poll's failure: a replacement runs next
        if (this.pass !== pass && pass.controller.signal.aborted) continue
        this.rejectWaiters(pass, waiterError(error))
        throw error
      }
    }
  }

  /**
   * Called when a poll stops or fails, wherever it did: the callers waiting are rejected, as they'd
   * otherwise wait out the backoff, and the queue stays for the next poll.
   */
  onPollStopped(error: unknown): void {
    if (this.pass) this.rejectWaiters(this.pass, waiterError(error))
  }

  private startPass(itemIds: ItemId[]): Pass {
    const previous = this.pass
    previous?.controller.abort(new AbortError('Re-encryption restarted'))
    const pass: Pass = {
      result: { succeeded: [], failed: [] },
      total: itemIds.length,
      done: 0,
      waiters: previous?.waiters ?? new Set(),
      controller: new AbortController(),
    }
    this.pass = pass
    this.queue = itemIds.map(itemId => ({ itemId, attempts: 0 }))
    if (itemIds.length > 0) this.setStage('reencrypting')
    return pass
  }

  private async runPass(pass: Pass, signal: AbortSignal): Promise<void> {
    while (this.pass === pass && this.queue.length > 0) {
      checkAlive(signal, () => this.deps.session.isOperational, 'Re-encryption aborted')
      const items = this.queue.splice(0, REWRITE_CHUNK_SIZE)
      const handled = new Set<ItemId>()
      try {
        await this.processChunk(items, pass, handled, signal)
      } catch (error) {
        if (this.pass === pass) {
          this.queue.unshift(...items.filter(item => !handled.has(item.itemId)))
        }
        throw error
      }
      // A replacement pass shares the waiters, which shouldn't see this pass's count
      if (this.pass === pass) this.reportProgress(pass)
    }
    if (this.pass === pass) this.finishPass(pass)
  }

  private finishPass(pass: Pass): void {
    this.reportProgress(pass)
    this.pass = null
    this.queue = []
    this.setStage(null)
    for (const waiter of pass.waiters) {
      this.settle(waiter, () => waiter.resolve(pass.result))
    }
    pass.waiters.clear()
  }

  private rejectWaiters(pass: Pass, error: unknown): void {
    for (const waiter of pass.waiters) {
      this.settle(waiter, () => waiter.reject(error))
    }
    pass.waiters.clear()
  }

  private settle(waiter: Waiter, settle: () => void): void {
    if (waiter.settled) return
    waiter.settled = true
    settle()
  }

  /**
   * A rewrite runs in the leader's polls, once the device has caught up: a device that hasn't read
   * the log for longer than its TTL (or has reset its sync state) merges the server's snapshots
   * first. Offline there's nothing to wait for. With `timeoutMs`, each wait gives up with a
   * `ReencryptionWaitError`.
   */
  private async waitUntilRewritesCanRun(outer: AbortSignal | undefined, timeoutMs?: number): Promise<void> {
    const canceller = new AbortController()
    this.cancellers.add(canceller)
    const signal = outer ? AbortSignal.any([outer, canceller.signal]) : canceller.signal
    try {
      if (!this.deps.session.isOnline) return
      if (!this.deps.session.isLeader) {
        this.setStage('waitingForLeader')
        this.deps.claimLeader()
        await this.waitFor('waitingForLeader', waitSignal => this.deps.session.whenLeader(waitSignal), signal, timeoutMs)
      }
      if (!this.deps.catchUp.isCaughtUp) {
        this.setStage('waitingForSync')
        await this.waitFor('waitingForSync', waitSignal => this.deps.catchUp.whenCaughtUp(waitSignal), signal, timeoutMs)
      }
    } finally {
      this.cancellers.delete(canceller)
    }
  }

  /** Puts the stage back once a wait ends without starting a pass */
  private restoreStage(): void {
    this.setStage(this.pass ? 'reencrypting' : null)
  }

  private async waitFor(
    stage: Exclude<ReencryptStage, 'reencrypting'>,
    wait: (signal?: AbortSignal) => Promise<void>,
    signal: AbortSignal,
    timeoutMs: number | undefined,
  ): Promise<void> {
    if (timeoutMs === undefined) {
      await wait(signal)
      return
    }
    try {
      await withTimeout(timeoutMs, wait, { signal })
    } catch (error) {
      // Only the timeout aborts without the caller's signal
      if (!signal.aborted && isAbortError(error)) {
        throw new ReencryptionWaitError(stage)
      }
      throw error
    }
  }

  private setStage(stage: ReencryptStage | null): void {
    if (this.currentStage === stage) return
    this.currentStage = stage
    try {
      this.deps.onStage?.(stage)
    } catch {
      // Ignore
    }
  }

  /**
   * Builds and uploads one chunk's snapshots. Each item it settles, or queues again for another
   * attempt, goes in `handled`; a request failure throws, leaving the rest for the next poll.
   */
  private async processChunk(
    items: QueuedItem[],
    pass: Pass,
    handled: Set<ItemId>,
    signal: AbortSignal,
  ): Promise<void> {
    await this.deps.pushToLog(items.map(item => item.itemId), signal)

    const settled = await Promise.allSettled(
      items.map(item => buildAfterPush(this.deps.builder, this.deps.pushToLog, item.itemId, signal)),
    )

    const ready: Array<UploadableSnapshot & { item: QueuedItem }> = []
    for (const [index, outcome] of settled.entries()) {
      const item = items[index]
      if (outcome.status === 'rejected') {
        // A push that failed the request as a whole says nothing about the item
        if (signal.aborted || isAbortError(outcome.reason) || isRequestFailure(outcome.reason)) {
          throw outcome.reason
        }
        await this.retryLater(item, pass, handled, {
          stage: 'build',
          error: `Failed to build snapshot for item ${item.itemId}: ${errorMessage(outcome.reason)}`,
        })
        continue
      }
      const result = outcome.value
      if (result.type === 'success') {
        ready.push({ item, snapshot: result.snapshot, heads: result.heads })
      } else if (result.type === 'deferred') {
        // Not broken: it waits for the log, so a later rewrite can retry it
        await this.retryLater(item, pass, handled, {
          stage: null,
          error: `The snapshot of item ${item.itemId} has to wait for the log`,
        })
      } else {
        const reason = result.type === 'not-ready' ? 'document or vault was not ready' : result.reason
        await this.retryLater(item, pass, handled, {
          stage: 'build',
          error: `Failed to build snapshot for item ${item.itemId}${reason ? `: ${reason}` : ''}`,
        })
      }
    }

    // The chunk already caps the item count
    const batches = SizeAwareBatchAccumulator.batch(ready, {
      maxBatchBytes: this.maxBatchBytes,
      calculateSize: entry => estimateSnapshotSize(entry.snapshot),
    })

    for (const batch of batches) {
      checkAlive(signal, () => this.deps.session.isOperational, 'Re-encryption aborted')
      let stored: typeof batch
      let rejected: typeof batch
      try {
        ({ stored, rejected } = await uploadSnapshotBatch(batch, {
          accountId: this.deps.accountId,
          apiClient: this.deps.apiClient,
          recorder: this.deps.recorder,
          signal,
        }))
      } catch (error) {
        // `SyncApiClient` has already turned auth errors it couldn't recover from into `AuthExpiredError`
        if (signal.aborted || isAbortError(error) || isRequestFailure(error)) throw error
        stored = []
        rejected = batch
        log.warn('A snapshot batch upload failed:', error)
      }
      for (const { item } of stored) {
        handled.add(item.itemId)
        pass.result.succeeded.push(item.itemId)
        pass.done += 1
      }
      for (const { item } of rejected) {
        await this.retryLater(item, pass, handled, {
          stage: 'upload',
          error: `Failed to upload the snapshot of item ${item.itemId} after ${MAX_REWRITE_ATTEMPTS} attempts`,
        })
      }
    }
  }

  /**
   * Queues an item again, or once it has used its attempts, records it as failed. A failure with a
   * stage is quarantined for manual recovery; one without (an item waiting for the log) isn't.
   */
  private async retryLater(
    item: QueuedItem,
    pass: Pass,
    handled: Set<ItemId>,
    failure: { stage: ManualRecoveryStage | null; error: string },
  ): Promise<void> {
    handled.add(item.itemId)
    item.attempts += 1
    if (item.attempts < MAX_REWRITE_ATTEMPTS) {
      if (this.pass === pass) this.queue.push(item)
      return
    }
    pass.done += 1
    const failed: FailedItem = { itemId: item.itemId, error: failure.error }
    pass.result.failed.push(failed)
    if (failure.stage === null) {
      log.warn(failure.error)
      return
    }
    log.error(failure.error)
    try {
      // The error stays in the logged result; the stored entry gets only the stage
      await this.deps.recoveryManager.quarantine(
        item.itemId,
        'snapshotFailure',
        { code: 'reencryptionFailed', stage: failure.stage },
      )
    } catch (storageErr) {
      log.error(`Failed to quarantine item ${item.itemId}:`, storageErr)
    }
  }

  /** Reports progress to every caller waiting on the pass */
  private reportProgress(pass: Pass): void {
    for (const waiter of pass.waiters) {
      try {
        waiter.onProgress?.(Math.min(pass.done, pass.total), pass.total)
      } catch {
        // Ignore
      }
    }
  }
}

/** What the callers waiting see when a request fails the pass */
function waiterError(error: unknown): unknown {
  if (isAbortError(error)) return error
  const classified = classifySyncError(error)
  if (classified.isAuth || isClientOutdatedError(error)) return error
  if (classified.isNetwork || classified.isServerError) {
    const errorType = classified.isServerError ? 'server error' : 'network error'
    return new Error(
      `Re-encryption aborted: ${errorType} (${classified.message || errorMessage(error)}). It will go on when sync resumes.`,
      { cause: error },
    )
  }
  return error
}
