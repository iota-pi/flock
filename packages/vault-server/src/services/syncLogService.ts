import type { z } from 'zod'
import type { PollLogSchema, SyncLogEntry } from '@vault/shared'
import type { LogPushResult, VaultDriver } from '../drivers/vaultDriver'
import type { AccountQuotas } from '../quotas'

export type PollLogInput = z.infer<typeof PollLogSchema>

/** The driver methods the sync service uses */
export type SyncRepository = Pick<VaultDriver, 'appendLog' | 'readLog'>

export interface PollLogResult {
  pushResults: LogPushResult[]
  entries: SyncLogEntry[]
  hasMore: boolean
  /** The server's clock, read after the log, so a client can tell how old a row is */
  serverNow: number
}

/**
 * Appends the client's messages to the account's log, then reads the log after `after`. A push past
 * the daily log quota throws `QuotaExceededError`, failing the whole poll, so the client backs off.
 */
export async function pollLog(
  vault: SyncRepository,
  input: PollLogInput,
  { logBytesPerDay }: Pick<AccountQuotas, 'logBytesPerDay'>,
): Promise<PollLogResult> {
  const pushResults = input.push.length > 0
    ? await vault.appendLog({ account: input.account, messages: input.push, maxBytesPerDay: logBytesPerDay })
    : []
  const { entries, hasMore } = await vault.readLog({ account: input.account, after: input.after })
  return { pushResults, entries, hasMore, serverNow: Date.now() }
}
