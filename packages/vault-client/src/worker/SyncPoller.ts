import type { SyncLogMessage } from '@vault/shared'
import type { ChangeOutbox, LogPushResult } from './ChangeOutbox'
import type { FirstStart } from './FirstStart'
import type { GapHealer } from './GapHealer'
import type { SyncApiClient } from './SyncApiClient'
import type { SyncLogPuller } from './SyncLogPuller'
import type { SyncSessionState } from './SyncSessionState'
import { AsyncMutex } from '../utils/AsyncMutex'
import { checkAlive } from '../utils/abort'
import { classifySyncError } from '../utils/errorClassifier'
import { createLogger } from '../utils/logger'

const log = createLogger('SyncPoller')

export type PollOutcome = 'success' | 'failure' | 'auth-failure' | 'no-poll'

export interface SyncPollerDeps {
  accountId: string
  session: SyncSessionState
  puller: Pick<
    SyncLogPuller,
    'cursor' | 'recordOwnPushes' | 'needsCatchUpManifest' | 'onCatchUpManifestSynced' | 'takeManifestSyncRequest' | 'process'
  >
  /** Read from the finished services: the outbox pushes through this poller */
  getOutbox: () => Pick<ChangeOutbox, 'pushPending'>
  firstStart: Pick<FirstStart, 'ensureSynced'>
  healer: Pick<GapHealer, 'runDue'>
  apiClient: Pick<SyncApiClient, 'pollLog'>
  /** Runs a manifest sync now, returning whether it fetched the manifest */
  syncManifest: (signal?: AbortSignal) => Promise<boolean>
}

export class SyncPoller {
  /** Pushes come from polls, snapshot uploads and rewrites, and only one may read the log at a time */
  private readonly exchangeMutex = new AsyncMutex()
  /** Exchanges completed, so that a poll that pushed nothing still reads the log */
  private exchanges = 0
  /** Set when the server's clock shows this device has to catch up before reading the page it got */
  private isCatchUpDue = false

  constructor(private readonly deps: SyncPollerDeps) {}

  private get isOperational(): boolean {
    return this.deps.session.isOperational
  }

  /**
   * Pushes pending changes and reads the log. Aborting `signal` cancels the poll, which then reports
   * `'no-poll'`. Polls go through the untracked client, so they don't show as activity in the sync status.
   */
  async executePoll(signal: AbortSignal = new AbortController().signal): Promise<PollOutcome> {
    if (!this.isOperational) return 'no-poll'

    try {
      await this.deps.firstStart.ensureSynced(signal)
      await this.catchUpIfNeeded(Date.now(), signal)

      const exchangesBefore = this.exchanges
      await this.deps.getOutbox().pushPending(signal)
      if (this.exchanges === exchangesBefore) {
        await this.exchange([], async () => {}, signal)
      }

      if (this.isCatchUpDue) {
        this.isCatchUpDue = false
        await this.runCatchUpManifest(signal)
        await this.exchange([], async () => {}, signal)
      }

      if (this.deps.puller.takeManifestSyncRequest()) {
        await this.deps.syncManifest(signal)
      }
      await this.deps.healer.runDue(signal)
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

  private async runCatchUpManifest(signal: AbortSignal): Promise<void> {
    if (!await this.deps.syncManifest(signal)) {
      throw new Error('Catching up needs the manifest, which could not be fetched')
    }
    this.deps.puller.onCatchUpManifestSynced()
  }

  /**
   * Sends `push` in one `pollLog` and reads the log. `onResults` runs before the entries are applied.
   * A page the device can't read yet is dropped, and read again once it has caught up.
   */
  readonly exchange = async (
    push: SyncLogMessage[],
    onResults: (results: LogPushResult[]) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> => {
    await this.exchangeMutex.runExclusive(async () => {
      checkAlive(signal, () => this.isOperational)
      const response = await this.deps.apiClient.pollLog(
        { account: this.deps.accountId, push, after: this.deps.puller.cursor },
        { signal },
      )
      checkAlive(signal, () => this.isOperational)

      this.deps.puller.recordOwnPushes(response.pushResults)
      await onResults(response.pushResults)
      this.exchanges += 1

      if (this.deps.puller.needsCatchUpManifest(response.serverNow)) {
        this.isCatchUpDue = true
        return
      }
      await this.deps.puller.process(response)
    })
  }
}
