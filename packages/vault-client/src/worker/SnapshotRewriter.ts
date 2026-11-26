import type { AutomergeIndexManager } from './docStore/AutomergeIndexManager'
import type { SyncApiClient } from './SyncApiClient'
import { classifySyncError } from '../utils/errorClassifier'
import { isClientOutdatedError, MAX_ITEM_SIZE_KB } from '@vault/shared'
import type { SyncLogPuller } from './SyncLogPuller'
import { AbortError, checkAlive, isAbortError, untilAborted, withTimeout } from '../utils/abort'
import { errorMessage } from '../utils/errorMessage'
import { fireAndForget } from '../utils/fireAndForget'
import type { ItemId } from '@vault/shared'
import type { ReencryptOptions, ReencryptResult, ReencryptStage } from '../shared/types'
import { ReencryptionWaitError } from '../shared/reencryptionWaitError'
import { SYNC_BATCH_SIZES } from '../shared/syncConfig'
import { createLogger } from '../utils/logger'
import type { SyncSessionState } from './SyncSessionState'
import { MAX_CONSECUTIVE_SNAPSHOT_FAILURES, SnapshotsRefusedError, type ItemUploadResult, type SnapshotPusher } from './SnapshotPusher'
import type { SnapshotSchedule } from './SnapshotSchedule'

const log = createLogger('SnapshotRewriter')

/**
 * How many times a pass builds and uploads an item before it gives up on it. It matches the failures
 * that quarantine an item, so an item that keeps failing is quarantined within the pass, and the cap
 * itself only stops an item that keeps waiting for the log.
 */
export const MAX_REWRITE_ATTEMPTS = MAX_CONSECUTIVE_SNAPSHOT_FAILURES
const REWRITE_CHUNK_SIZE = SYNC_BATCH_SIZES.reencryptChunk

/** One call's options for `SnapshotRewriter.request` */
export interface RewriteRequestOptions extends ReencryptOptions {
  onProgress?: (done: number, total: number) => void
  /** Stops this caller waiting. The rewrite goes on for any other caller; `cancel` stops it. */
  signal?: AbortSignal
}

export interface SnapshotRewriterOptions {
  /**
   * The snapshot pusher's per-item pipeline, which builds, uploads, records what the server stored
   * and quarantines what keeps failing, as it does for the snapshot phase
   */
  uploader: Pick<SnapshotPusher, 'uploadItems'>
  /**
   * Holds the quota delay the uploader sets when the server turns uploads away (429): the rewrite
   * phase waits it out, as the snapshot phase does
   */
  schedule: Pick<SnapshotSchedule, 'isDeferred' | 'liftDeferral'>
  indexManager: Pick<AutomergeIndexManager, 'listItemIds'>
  apiClient: Pick<SyncApiClient, 'getValidToken'>
  /** Rewrites run in the session's polls, while online */
  session: SyncSessionState
  /**
   * Whether catch-up's manifest sync has merged the server's snapshots. A rewrite before then could
   * replace a snapshot with one that lacks what only that snapshot holds.
   */
  catchUp: Pick<SyncLogPuller, 'isCaughtUp' | 'whenCaughtUp'>
  /** Runs a poll now, or right after the one in flight, resolving once it has finished */
  runPollNow: () => Promise<void>
  /** Called whenever the rewrite's stage changes, and with null once it stops */
  onStage?: (stage: ReencryptStage | null) => void
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
 * uploads them, so rewrites share the poll's abort, auth pause and backoff (sync rule 4).
 * A request failure fails the poll and the callers waiting, and leaves the rest of the queue for the
 * next poll. A refusal for the account's storage quota (429) rejects the callers waiting but leaves
 * the poll's result alone, as in the snapshot phase, and the queue waits out the quota delay.
 */
export class SnapshotRewriter {
  /** One for each request or `prepare` waiting for catch-up, which `cancel` aborts */
  private readonly cancellers = new Set<AbortController>()
  private queue: QueuedItem[] = []
  private pass: Pass | null = null
  private currentStage: ReencryptStage | null = null

  constructor(private readonly deps: SnapshotRewriterOptions) {}

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
      // A new request tries once, even while waiting out the quota delay: storage may have freed up
      this.deps.schedule.liftDeferral()
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
   *
   * The server turning uploads away for the account's quota (429) isn't the poll's failure, since
   * pulls still work: the callers waiting are rejected, and the queue stays until the quota delay
   * (`SnapshotSchedule.deferUntil`) is over, as the snapshot phase's dirty items do.
   */
  async runDue(signal: AbortSignal): Promise<void> {
    while (this.pass && this.queue.length > 0) {
      if (!this.deps.session.isOperational || !this.deps.catchUp.isCaughtUp) return
      const pass = this.pass
      if (this.deps.schedule.isDeferred()) {
        this.rejectWaiters(pass, quotaWaiterError())
        return
      }
      try {
        await this.runPass(pass, AbortSignal.any([signal, pass.controller.signal]))
      } catch (error) {
        // Cancelled or replaced, which isn't the poll's failure: a replacement runs next
        if (this.pass !== pass && pass.controller.signal.aborted) continue
        if (error instanceof SnapshotsRefusedError) {
          log.warn('The server turned snapshots away; rewriting the rest later', error.cause)
          this.rejectWaiters(pass, quotaWaiterError(error))
          return
        }
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
   * A rewrite runs in the session's polls, once the device has caught up: a device that hasn't read
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
   * Builds and uploads one chunk's snapshots through the snapshot pusher's pipeline. Each item it
   * settles, or queues again for another attempt, goes in `handled`; a request failure throws,
   * leaving the rest for the next poll.
   */
  private async processChunk(
    items: QueuedItem[],
    pass: Pass,
    handled: Set<ItemId>,
    signal: AbortSignal,
  ): Promise<void> {
    const byId = new Map(items.map(item => [item.itemId, item]))
    await this.deps.uploader.uploadItems(items.map(item => item.itemId), {
      signal,
      includeClean: true,
      onItemResult: (itemId, result) => {
        const item = byId.get(itemId)
        if (!item) return
        handled.add(itemId)
        this.recordResult(item, pass, result)
      },
    })
  }

  /**
   * Records what became of an item, or queues it again. An item that's oversized or now quarantined
   * goes in `failed` at once; one that failed or is waiting for the log gets another attempt, up to
   * `MAX_REWRITE_ATTEMPTS`. Quarantining is the pipeline's, so an item that gives up while waiting
   * for the log isn't quarantined, and a later rewrite can retry it.
   */
  private recordResult(item: QueuedItem, pass: Pass, result: ItemUploadResult): void {
    if (result.type === 'stored') {
      pass.result.succeeded.push(item.itemId)
      pass.done += 1
      return
    }
    item.attempts += 1
    const terminal = result.type === 'oversized' || (result.type === 'failed' && result.quarantined)
    if (!terminal && item.attempts < MAX_REWRITE_ATTEMPTS) {
      if (this.pass === pass) this.queue.push(item)
      return
    }
    pass.done += 1
    const error = describeFailure(item.itemId, result, item.attempts)
    pass.result.failed.push({ itemId: item.itemId, error })
    if (result.type === 'waiting') {
      log.warn(error)
    } else {
      log.error(error)
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

/** What the callers waiting see when the server turns uploads away for the account's storage quota */
function quotaWaiterError(cause?: unknown): Error {
  return new Error(
    'Re-encryption paused: the account has reached its storage quota. It will go on once storage frees up.',
    { cause },
  )
}

/** Why a pass gave up on an item, for its result and the log */
function describeFailure(itemId: ItemId, result: Exclude<ItemUploadResult, { type: 'stored' }>, attempts: number): string {
  switch (result.type) {
    case 'oversized':
      return `The snapshot of item ${itemId} (${Math.round(result.sizeBytes / 1024)} KB) exceeds the ${MAX_ITEM_SIZE_KB} KB limit`
    case 'waiting':
      return result.reason === 'deferred'
        ? `The snapshot of item ${itemId} has to wait for the log`
        : `Failed to build snapshot for item ${itemId}: document or vault was not ready`
    case 'failed':
      return result.stage === 'build'
        ? `Failed to build snapshot for item ${itemId}${result.reason ? `: ${result.reason}` : ''}`
        : `Failed to upload the snapshot of item ${itemId} after ${attempts} attempts`
  }
}
