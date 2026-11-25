import type { SyncLogMessage } from '@vault/shared'
import type { LogPushResult } from './ChangeOutbox'
import type { SyncApiClient } from './SyncApiClient'
import type { SyncLogPuller } from './SyncLogPuller'
import type { SyncSessionState } from './SyncSessionState'
import { AsyncMutex } from '../utils/AsyncMutex'
import { checkAlive } from '../utils/abort'

export interface LogExchangeDeps {
  accountId: string
  session: Pick<SyncSessionState, 'isOperational'>
  puller: Pick<SyncLogPuller, 'cursor' | 'recordOwnPushes' | 'needsCatchUpManifest' | 'onBehindSeen' | 'process'>
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
   * so a pull sees the state the acknowledgement leaves. A page the device can't read yet is dropped,
   * and read again once it has caught up.
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
      checkAlive(signal, () => session.isOperational)

      puller.recordOwnPushes(response.pushResults)
      await onResults(response.pushResults)
      this.completed += 1

      if (puller.needsCatchUpManifest(response.serverNow)) {
        puller.onBehindSeen()
        return
      }
      await puller.process(response)
    })
  }
}
