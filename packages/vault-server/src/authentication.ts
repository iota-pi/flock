import type { StoredAccount, VaultAccountWithAuth } from './drivers/vaultDriver'
import { AuthenticationError, ExpiredSessionError, TooManyLoginAttemptsError } from './errors'
import { isLoginDevice } from './loginDevices'
import { isLoginLocked, type FailedLoginRecord } from './loginThrottle'
import { isSessionFor, normalizeSessionRecords } from './sessions'
import { safeEqual } from './util'

/** Whether `authTokenHash`, the hash of the auth token a client sent, is the account's */
export function matchesAuthTokenHash(record: Pick<StoredAccount, 'authToken'>, authTokenHash: string): boolean {
  return safeEqual(authTokenHash, record.authToken)
}

export interface LoginAttempt {
  /** The hash of the auth token the client sent */
  authTokenHash: string
  /** The hash of the device token the client sent, if it sent one (see loginDevices.ts) */
  deviceHash?: string
}

/**
 * Checks a login against the stored account record and the failed logins counted against its ID.
 * Returns normally when the login is valid. Throws `TooManyLoginAttemptsError` while the ID is
 * locked, and `AuthenticationError` when the account doesn't exist or the hash doesn't match.
 *
 * A locked ID refuses every login, whatever the password and whether or not the account exists, so
 * that guessers learn nothing from it: neither the password nor that the account is real. The one
 * exception is the right password from one of the account's login devices, which an attacker
 * locking the account can't produce.
 */
export function authenticateLogin(
  record: StoredAccount | undefined,
  throttle: FailedLoginRecord,
  { authTokenHash, deviceHash }: LoginAttempt,
  now = Date.now(),
): void {
  if (isLoginLocked(throttle, now)) {
    const fromLoginDevice = record !== undefined
      && matchesAuthTokenHash(record, authTokenHash)
      && isLoginDevice(record, deviceHash)
    if (!fromLoginDevice) {
      throw new TooManyLoginAttemptsError('Too many failed logins for this account ID')
    }
  }
  if (!record) {
    throw new AuthenticationError('Could not find account')
  }
  if (!matchesAuthTokenHash(record, authTokenHash)) {
    // Give same error as if account not found to avoid leaking account ids
    throw new AuthenticationError(`Could not find account ${record.account}`)
  }
}

/**
 * Checks a session token against the stored account record. Returns the account with only its
 * active sessions. Throws `AuthenticationError` when the account doesn't exist, and
 * `ExpiredSessionError` when the token isn't one of its active sessions.
 */
export function authenticateSession(
  record: StoredAccount | undefined,
  session: string,
  now = Date.now(),
): VaultAccountWithAuth {
  if (!session) {
    throw new AuthenticationError('Session is required to get account')
  }
  if (!record) {
    throw new AuthenticationError('Could not find account')
  }
  const activeSessions = normalizeSessionRecords(record.sessions, now)
  if (!activeSessions.some(active => isSessionFor(active, session))) {
    throw new ExpiredSessionError('Invalid session token')
  }
  return { ...record, sessions: activeSessions, session }
}
