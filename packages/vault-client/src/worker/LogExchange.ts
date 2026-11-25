import type { SyncLogMessage } from '@vault/shared'
import type { LogPushResult } from './ChangeOutbox'
import type { SyncApiClient } from './SyncApiClient'
import type { SyncLogPuller } from './SyncLogPuller'
import type { SyncSessionState } from './SyncSessionState'
import { AsyncMutex } from '../utils/AsyncMutex'
import { checkAlive } from '../utils/abort'

export interface LogExchangeDeps {
  accountId: string
  session: Pick<SyncSessionState, 'isOperational' | 'isShutdown'>
  puller: Pick<SyncLogPuller, 'cursor' | 'recordOwnPushes' | 'dropPageIfBehind' | 'process'>
  apiClient: Pick<SyncApiClient, 'pollLog'>
}

/**
 * Sends pushes to the log and reads it in one `pollLog`. Pushes come from polls and snapshot
 * rewrites, and only one exchange may read the log at a time, so each reads from the cursor the last
 * one left.
 */
export class LogExchange {
  private readonly mutex = new AsyncMutex()
  private completed = 0

  constructor(private readonly deps: LogExchangeDeps) {}

  /** Exchanges completed, so that a poll that pushed nothing still reads the log */
  get count(): number {
    return this.completed
  }

  /**
   * Sends `push` in one `pollLog` and reads the log. `onResults` runs before the entries are applied,
   * so a pull sees the state the acknowledgement leaves, and it runs even if `signal` aborts once the
   * server has answered, unless the session is shutting down. A page the device can't read yet is dropped,
   * and read again at once after catch-up's manifest sync (rule 4).
   */
  readonly exchange = async (
    push: SyncLogMessage[],
    onResults: (results: LogPushResult[]) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> => {
    const { session, puller, apiClient, accountId } = this.deps
    await this.mutex.runExclusive(async () => {
      checkAlive(signal, () => session.isOperational)
      const response = await apiClient.pollLog({ account: accountId, push, after: puller.cursor }, { signal })

      // The server stored the pushes even if the exchange was aborted meanwhile (leadership moved, or
      // the device went offline), so record them first: otherwise the marks stay and the next poll
      // pushes them again, and the rows come back as another device's. A session that is shutting
      // down records nothing, since it can no longer mark the items dirty, and resends them next time.
      checkAlive(null, !session.isShutdown, 'Sync session is shut down')
      puller.recordOwnPushes(response.pushResults)
      await onResults(response.pushResults)

      checkAlive(signal, () => session.isOperational)
      this.completed += 1

      if (puller.dropPageIfBehind(response)) return
      await puller.process(response)
    })
  }
}
