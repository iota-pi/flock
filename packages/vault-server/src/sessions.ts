import { hashString, safeEqual } from './util'

export const SESSION_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
export const SESSION_RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1000 // 1 day
export const SESSION_RENEWAL_THRESHOLD_MS = SESSION_EXPIRY_MS - SESSION_RENEWAL_WINDOW_MS // 29 days
export const MAX_ACTIVE_SESSIONS = 8

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
