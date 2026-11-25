import type { ChangeOutbox } from './ChangeOutbox'
import type { GapHealer } from './GapHealer'
import type { LogExchange } from './LogExchange'
import type { ManifestMode, ManifestPhaseResult } from './ManifestSyncManager'
import type { SnapshotPusher } from './SnapshotPusher'
import type { SyncLogPuller } from './SyncLogPuller'
import type { SyncSessionState } from './SyncSessionState'
import { classifySyncError } from '../utils/errorClassifier'
import { createLogger } from '../utils/logger'

const log = createLogger('SyncPoller')

export type PollOutcome = 'success' | 'failure' | 'auth-failure' | 'no-poll'

export interface SyncPollerDeps {
  session: Pick<SyncSessionState, 'isOperational'>
  puller: Pick<
    SyncLogPuller,
    'needsCatchUpManifest' | 'onCatchUpManifestSynced' | 'onRecoveryManifestSynced' | 'pendingManifestSync'
  >
  /** Reads the log, and carries the outbox's pushes */
  exchange: Pick<LogExchange, 'exchange' | 'count'>
  outbox: Pick<ChangeOutbox, 'pushPending'>
  healer: Pick<GapHealer, 'runDue'>
  /**
   * The manifest phase: runs a manifest sync if one is asked for, at least `minMode`, or due, and
   * returns null if none ran. Throws if the manifest can't be fetched.
   */
  runManifestPhase: (signal: AbortSignal, minMode?: ManifestMode) => Promise<ManifestPhaseResult | null>
  /** Uploads the snapshots that are due, throwing if a request fails */
  snapshots: Pick<SnapshotPusher, 'pushDue'>
}

export class SyncPoller {
  constructor(private readonly deps: SyncPollerDeps) {}

  private get isOperational(): boolean {
    return this.deps.session.isOperational
  }

  /**
   * Pushes pending changes, reads the log, runs the manifest sync if it's due, then uploads the
   * snapshots that are due, after the pushes that must precede them (S1). Aborting `signal` cancels
   * the poll, which then reports `'no-poll'`. Polls go through the untracked client, so they don't
   * show as activity in the sync status.
   */
  async executePoll(signal: AbortSignal = new AbortController().signal): Promise<PollOutcome> {
    if (!this.isOperational) return 'no-poll'

    try {
      await this.catchUpIfNeeded(Date.now(), signal)

      const { exchange } = this.deps
      const exchangesBefore = exchange.count
      await this.deps.outbox.pushPending(signal)
      if (exchange.count === exchangesBefore) {
        await exchange.exchange([], async () => {}, signal)
      }

      if (this.deps.puller.pendingManifestSync === 'catchUp') {
        await this.runCatchUpManifest(signal)
        await exchange.exchange([], async () => {}, signal)
      }
      if (this.deps.puller.pendingManifestSync === 'recovery') {
        await this.runRecoveryManifest(signal)
      }
      // After catch-up or recovery has run one, the periodic sync isn't due
      await this.deps.runManifestPhase(signal)
      await this.deps.healer.runDue(signal)
      await this.deps.snapshots.pushDue(signal)
      return 'success'
    } catch (error) {
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

  private async catchUpIfNeeded(now: number, signal: AbortSignal): Promise<void> {
    if (this.deps.puller.needsCatchUpManifest(now)) {
      await this.runCatchUpManifest(signal)
    }
  }

  private async fetchManifestNow(signal: AbortSignal): Promise<boolean> {
    const result = await this.deps.runManifestPhase(signal, 'now')
    return result?.fetchedManifest ?? false
  }

  private async runCatchUpManifest(signal: AbortSignal): Promise<void> {
    if (!await this.fetchManifestNow(signal)) {
      throw new Error('Catching up needs the manifest, which could not be fetched')
    }
    this.deps.puller.onCatchUpManifestSynced()
  }

  /** Recovers what lost log rows held. The request stays until a sync fetches the manifest (rule 4). */
  private async runRecoveryManifest(signal: AbortSignal): Promise<void> {
    if (!await this.fetchManifestNow(signal)) {
      throw new Error('Recovering lost log rows needs the manifest, which could not be fetched')
    }
    this.deps.puller.onRecoveryManifestSynced()
  }
}
