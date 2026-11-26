import type { SyncLogMessage } from '@vault/shared'
import type { LogPushResult } from './ChangeOutbox'
import type { SyncApiClient } from './SyncApiClient'
import type { SyncLogPuller } from './SyncLogPuller'
import type { SyncSessionState } from './SyncSessionState'
import { checkAlive } from '../utils/abort'

export interface LogExchangeDeps {
  accountId: string
  session: Pick<SyncSessionState, 'isOperational' | 'isShutdown'>
  puller: Pick<SyncLogPuller, 'cursor' | 'recordOwnPushes' | 'dropPageIfBehind' | 'process'>
  apiClient: Pick<SyncApiClient, 'pollLog'>
}

/**
 * Sends `push` in one `pollLog` and reads the log. `onResults` runs before the entries are applied,
 * so a pull sees the state the acknowledgement leaves, and it runs even if `signal` aborts once the
 * server has answered, unless the session is shutting down. A page the device can't read yet is
 * dropped, and read again at once after catch-up's manifest sync (rule 4).
 *
 * Only a poll may exchange, passing its signal: `SyncOrchestrator` runs one poll at a time, so each
 * exchange reads from the cursor the last one left.
 */
export type LogExchange = (
  push: SyncLogMessage[],
  onResults: (results: LogPushResult[]) => Promise<void>,
  signal: AbortSignal,
) => Promise<void>

export function createLogExchange(deps: LogExchangeDeps): LogExchange {
  const { session, puller, apiClient, accountId } = deps
  return async (push, onResults, signal) => {
    checkAlive(signal, () => session.isOperational)
    const response = await apiClient.pollLog({ account: accountId, push, after: puller.cursor }, { signal })

    // The server stored the pushes even if the exchange was aborted meanwhile (the device went
    // offline), so record them first: otherwise the marks stay and the next poll
    // pushes them again, and the rows come back as another device's. A session that is shutting
    // down records nothing, since it can no longer mark the items dirty, and resends them next time.
    checkAlive(null, !session.isShutdown, 'Sync session is shut down')
    puller.recordOwnPushes(response.pushResults)
    await onResults(response.pushResults)

    checkAlive(signal, () => session.isOperational)
    if (puller.dropPageIfBehind(response)) return
    await puller.process(response)
  }
}
