/**
 * The account doesn't exist, or the credentials (the auth token hash or a session token) don't
 * match it. Routers report it as UNAUTHORIZED. Other driver errors, such as a DynamoDB timeout, say
 * nothing about the credentials and must not be reported that way, or the client drops its session.
 */
export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthenticationError'
  }
}

export class ExpiredSessionError extends AuthenticationError {
  constructor(message: string) {
    super(message)
    this.name = 'ExpiredSessionError'
  }
}

/** The account has had too many failed logins recently. Routers report it as TOO_MANY_REQUESTS. */
export class TooManyLoginAttemptsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TooManyLoginAttemptsError'
  }
}

/** A page token that is malformed, or was issued for another account, item or query */
export class InvalidPageTokenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidPageTokenError'
  }
}
