/**
 * Failed logins an account may have within the window before further logins are refused, even with
 * the right password, until the window ends. Counting per account catches guessing spread over many
 * IPs. Anyone who knows an account ID can lock it for up to a window. Current IDs are too many to
 * try them all, but legacy 4-character ones can be enumerated, so only rate limits in front of the
 * API stop someone locking those in bulk.
 */
export const MAX_FAILED_LOGINS = 10
export const FAILED_LOGIN_WINDOW_MS = 15 * 60 * 1000

export interface FailedLoginRecord {
  failedLogins?: number
  failedLoginsSince?: number
}

export function isLoginLocked({ failedLogins, failedLoginsSince }: FailedLoginRecord, now: number): boolean {
  if (!failedLogins || failedLoginsSince === undefined) return false
  return failedLogins >= MAX_FAILED_LOGINS && failedLoginsSince > now - FAILED_LOGIN_WINDOW_MS
}
