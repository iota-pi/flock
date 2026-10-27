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

/** The account has had too many failed logins recently. Routers report it as TOO_MANY_REQUESTS. */
export class TooManyLoginAttemptsError extends Error {
  override name = 'TooManyLoginAttemptsError'
}

/** A page token that is malformed, or was issued for another account, item or query */
export class InvalidPageTokenError extends Error {
  override name = 'InvalidPageTokenError'
}
