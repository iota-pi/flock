export class HttpError extends Error {
  statusCode: number
  constructor(statusCode: number, message: string) {
    super(message)
    this.statusCode = statusCode
    this.name = 'HttpError'
  }
}

/**
 * The account doesn't exist, or the credentials (the auth token hash or a session token) don't
 * match it. Routers report it as UNAUTHORIZED. Other driver errors, such as a DynamoDB timeout, say
 * nothing about the credentials and must not be reported that way, or the client drops its session.
 */
export class AuthenticationError extends HttpError {
  constructor(message: string) {
    super(401, message)
    this.name = 'AuthenticationError'
  }
}

export class ExpiredSessionError extends AuthenticationError {
  constructor(message: string) {
    super(message)
    this.name = 'ExpiredSessionError'
  }
}

/** A page token that is malformed, or was issued for another account, item or query */
export class InvalidPageTokenError extends HttpError {
  constructor(message: string) {
    super(400, message)
    this.name = 'InvalidPageTokenError'
  }
}
