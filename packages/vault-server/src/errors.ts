/**
 * The account doesn't exist, or the credentials (the auth token hash or a session token) don't
 * match it (see authentication.ts). Routers report it as UNAUTHORIZED. Driver errors, such as a DynamoDB timeout, say
 * nothing about the credentials and must not be reported that way, or the client drops its session.
 */
export class AuthenticationError extends Error {
  override name = 'AuthenticationError'
}

export class ExpiredSessionError extends AuthenticationError {
  override name = 'ExpiredSessionError'
}

/**
 * A write would take the account past one of its quotas (see quotas.ts). Routers report it as
 * TOO_MANY_REQUESTS with `QUOTA_EXCEEDED_MESSAGE`.
 */
export class QuotaExceededError extends Error {
  override name = 'QuotaExceededError'
}

/** The account has had too many failed logins recently. Routers report it as TOO_MANY_REQUESTS. */
export class TooManyLoginAttemptsError extends Error {
  override name = 'TooManyLoginAttemptsError'
}
