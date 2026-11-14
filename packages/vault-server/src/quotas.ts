import { QUOTA_EXCEEDED_MESSAGE } from '@vault/shared'
import { QuotaExceededError } from './errors'
import type { TrpcErrorMapping } from './trpc/errors'

/**
 * Limits on how much one account can store, so that an account (or a script holding one) can't run
 * up unbounded storage and write costs. Real accounts are far below them. A client over a quota gets
 * TOO_MANY_REQUESTS and backs off as it does for any 429, keeping its changes locally until the
 * write is accepted.
 */
export interface AccountQuotas {
  /**
   * Most bytes the account's items may take up as stored. A write is checked against the usage
   * before it, so an account can pass this by up to one request's worth (25 snapshots).
   */
  storageBytes: number
  /**
   * Most bytes of messages the account may append to its log per UTC day. Rows expire after
   * `SYNC_LOG_TTL_DAYS`, so this also bounds how much log an account can hold.
   */
  logBytesPerDay: number
}

export const DEFAULT_ACCOUNT_QUOTAS: AccountQuotas = {
  storageBytes: 256 * 1024 * 1024,
  // Pushing an item's whole history to the log comes before its first snapshot, so a large account
  // signing in on a new device for the first time, or importing its data, appends about its size
  logBytesPerDay: 64 * 1024 * 1024,
}

/** How routers report a `QuotaExceededError` */
export const QUOTA_EXCEEDED_MAPPING: TrpcErrorMapping = {
  error: QuotaExceededError,
  code: 'TOO_MANY_REQUESTS',
  message: QUOTA_EXCEEDED_MESSAGE,
}
