import type { ChangeOutbox } from './ChangeOutbox'
import type { ItemReconciler } from './ItemReconciler'
import type { LogExchange } from './LogExchange'
import type { ManifestPhaseResult, ManifestStage } from './ManifestSyncManager'
import type { SnapshotPusher } from './SnapshotPusher'
import type { SnapshotRewriter } from './SnapshotRewriter'
import type { SyncLogPuller } from './SyncLogPuller'
import type { SyncSessionState } from './SyncSessionState'
import { classifySyncError } from '../utils/errorClassifier'
import { createLogger } from '../utils/logger'

const log = createLogger('SyncPoller')

export type PollOutcome = 'success' | 'failure' | 'auth-failure' | 'no-poll'

export interface SyncPollerDeps {
  session: Pick<SyncSessionState, 'isOperational'>
  puller: Pick<SyncLogPuller, 'demandCatchUpIfBehind'>
  /** Reads the log, and carries the outbox's pushes */
  exchange: LogExchange
  /** Pushes pending changes, returning whether a push read the log */
  outbox: Pick<ChangeOutbox, 'pushPending'>
  reconciler: Pick<ItemReconciler, 'runDue'>
  /**
   * A manifest phase (`ManifestSyncManager.runPhase`): runs a manifest sync if one is demanded for
   * `stage`, asked for or due, and returns null if none ran. Throws if the manifest can't be fetched.
   */
  runManifestPhase: (stage: ManifestStage, signal: AbortSignal) => Promise<ManifestPhaseResult | null>
  /** Uploads the snapshots that are due, throwing if a request fails */
  snapshots: Pick<SnapshotPusher, 'pushDue'>
  /** Uploads the queued snapshot rewrites, throwing if a request fails */
  rewrites: Pick<SnapshotRewriter, 'runDue' | 'onPollStopped'>
}

export class SyncPoller {
  constructor(private readonly deps: SyncPollerDeps) {}

  private get isOperational(): boolean {
    return this.deps.session.isOperational
  }

  /**
   * Runs the manifest sync that must come before reading the log, such as catching up, then pushes
   * pending changes and reads the log, then runs any other manifest sync that is demanded, asked for
   * or due, then heals parked rows, uploads the snapshots that are due and runs any queued snapshot rewrites,
   * after the pushes that must precede them (S1). Aborting `signal` cancels the poll, which then reports `'no-poll'`. Polls go
   * through the untracked client, so they don't show as activity in the sync status.
   */
  async executePoll(signal: AbortSignal = new AbortController().signal): Promise<PollOutcome> {
    if (!this.isOperational) return 'no-poll'

    try {
      this.deps.puller.demandCatchUpIfBehind(Date.now())
      await this.deps.runManifestPhase('beforeRead', signal)

      if (!await this.deps.outbox.pushPending(signal)) {
        await this.deps.exchange([], async () => {}, signal)
      }

      await this.deps.runManifestPhase('afterRead', signal)
      await this.deps.reconciler.runDue(signal)
      await this.deps.snapshots.pushDue(signal)
      await this.deps.rewrites.runDue(signal)
      return 'success'
    } catch (error) {
      // A rewrite's callers hear of it now, rather than waiting out the backoff
      this.deps.rewrites.onPollStopped(error)
      const classified = classifySyncError(error)
      if (classified.isAbort || signal.aborted || !this.isOperational) {
        return 'no-poll'
      }

      if (classified.isAuth) {
        log.error('Auth failure during polling', error)
        return 'auth-failure'
      }

      log.error('Polling failed', error)
      return 'failure'
    }
  }
}
