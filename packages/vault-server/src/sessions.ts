import type { VaultAccountWithAuth, VaultSessionRecord } from './drivers/base'
import { hashString, safeEqual } from './util'

export const SESSION_EXPIRY_MS = 72 * 60 * 60 * 1000 // 72 hours
export const SESSION_RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1000 // 1 day
export const SESSION_RENEWAL_THRESHOLD_MS = SESSION_EXPIRY_MS - SESSION_RENEWAL_WINDOW_MS // 48 hours
export const MAX_ACTIVE_SESSIONS = 8
/** Allows for clock differences between server instances when checking a session expiry against its lifetime */
export const SESSION_CLOCK_SKEW_MS = 60_000

/**
 * Session records hold this hash rather than the token, so that someone who can read the accounts
 * table can't use it to sign in.
 */
export function hashSessionToken(token: string): string {
  return hashString(token)
}

/**
 * Whether a stored session record is for `token`. Records written before tokens were hashed hold
 * the token itself. Renewing one rewrites it hashed, and the rest expire within SESSION_EXPIRY_MS
 * of the change, after which the second comparison can go. Until then a stored hash also works as
 * a token, which is no worse than the raw tokens stored before.
 */
export function isSessionFor(record: { token: string }, token: string): boolean {
  return safeEqual(hashSessionToken(token), record.token) || safeEqual(token, record.token)
}

/**
 * The active sessions in a stored `sessions` attribute: well-formed, unexpired and deduplicated, and
 * at most MAX_ACTIVE_SESSIONS of them (the latest to expire)
 */
export function normalizeSessionRecords(value: unknown, now = Date.now()): VaultSessionRecord[] {
  if (!Array.isArray(value)) {
    return []
  }

  const deduped = new Map<string, VaultSessionRecord>()
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      continue
    }

    const token = (entry as { token?: unknown }).token
    const expiry = (entry as { expiry?: unknown }).expiry
    if (typeof token !== 'string' || token.length === 0) {
      continue
    }

    if (typeof expiry !== 'number' || !Number.isFinite(expiry) || expiry <= now) {
      continue
    }
    // Ends sessions issued under a longer lifetime, rather than letting them run it out
    if (expiry > now + SESSION_EXPIRY_MS + SESSION_CLOCK_SKEW_MS) {
      continue
    }

    deduped.set(token, { token, expiry })
  }

  return Array.from(deduped.values())
    .sort((left, right) => left.expiry - right.expiry)
    .slice(-MAX_ACTIVE_SESSIONS)
}

export function shouldRenewSession(
  accountData: Pick<VaultAccountWithAuth, 'sessions'>,
  authToken: string,
  now = Date.now(),
): boolean {
  const currentSession = accountData.sessions?.find(s => isSessionFor(s, authToken))

  if (!currentSession || !Number.isFinite(currentSession.expiry)) {
    return true
  }

  return currentSession.expiry - now < SESSION_RENEWAL_THRESHOLD_MS
}

/** The active sessions with one for `token` added */
export function addSessionRecord(
  activeSessions: VaultSessionRecord[],
  token: string,
  expiry: number,
): VaultSessionRecord[] {
  return [...activeSessions, { token: hashSessionToken(token), expiry }]
}

/**
 * The active sessions with the one for `token` given a full lifetime, or undefined to leave them as
 * they are: when there is no such session, or when this is a retry and a concurrent request has
 * just renewed it.
 */
export function renewSessionRecord(
  activeSessions: VaultSessionRecord[],
  token: string,
  now: number,
  isRetry: boolean,
): VaultSessionRecord[] | undefined {
  const index = activeSessions.findIndex(active => isSessionFor(active, token))
  if (index === -1) {
    return undefined
  }

  if (isRetry && activeSessions[index].expiry >= now + SESSION_EXPIRY_MS - SESSION_CLOCK_SKEW_MS) {
    return undefined
  }

  const renewed = activeSessions.slice()
  // Also rewrites a record from before tokens were hashed
  renewed[index] = { token: hashSessionToken(token), expiry: now + SESSION_EXPIRY_MS }
  return renewed
}
