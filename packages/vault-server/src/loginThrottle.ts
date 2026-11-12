/**
 * Failed logins an account ID may have within the window before further logins are refused, even
 * with the right password, until the window ends. Counting per ID catches guessing spread over many
 * IPs. IDs with no account are counted and locked the same way, so the lock doesn't tell anyone
 * which accounts exist.
 *
 * Anyone who knows an account ID can lock it for up to a window, and keep it locked. The account's
 * login devices (see loginDevices.ts) still get in with the right password, but a new device can't
 * until the lock ends. Only rate limits in front of the API stop someone locking accounts in bulk.
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
