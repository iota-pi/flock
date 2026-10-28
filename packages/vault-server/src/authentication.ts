import type { StoredAccount, VaultAccountWithAuth } from './drivers/vaultDriver'
import { AuthenticationError, ExpiredSessionError, TooManyLoginAttemptsError } from './errors'
import { isLoginLocked } from './loginThrottle'
import { isSessionFor, normalizeSessionRecords } from './sessions'
import { safeEqual } from './util'

/** Whether `authTokenHash`, the hash of the auth token a client sent, is the account's */
export function matchesAuthTokenHash(record: Pick<StoredAccount, 'authToken'>, authTokenHash: string): boolean {
  return !!authTokenHash && safeEqual(authTokenHash, record.authToken)
}

/**
 * Checks a login against the stored account record. `authTokenHash` is the hash of the auth token
 * the client sent. Returns normally when the login is valid. Throws `TooManyLoginAttemptsError`
 * while the account is locked, and `AuthenticationError` when the account doesn't exist or the hash
 * doesn't match.
 */
export function authenticateLogin(
  record: StoredAccount | undefined,
  authTokenHash: string,
  now = Date.now(),
): void {
  if (!record) {
    throw new AuthenticationError('Could not find account')
  }
  // Checked first, so that a locked account gives guessers no answer
  if (isLoginLocked(record, now)) {
    throw new TooManyLoginAttemptsError(`Too many failed logins for account ${record.account}`)
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
