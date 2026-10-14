export class HttpError extends Error {
  statusCode: number
  constructor(statusCode: number, message: string) {
    super(message)
    this.statusCode = statusCode
    this.name = 'HttpError'
  }
}

export class ExpiredSessionError extends HttpError {
  constructor(message: string) {
    super(403, message)
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
