import { parseError, type ParsedError } from './errorParser'

export function isAuthError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }

  const parsed = parseError(error)
  return matchesAuthError(parsed)
}

function matchesAuthError(parsed: ParsedError): boolean {
  const httpStatus = parsed.status
  if (httpStatus === 401 || httpStatus === 403) {
    return true
  }

  const code = parsed.code
  if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN') {
    return true
  }

  const name = parsed.name
  if (name === 'UnauthorizedError' || name === 'ForbiddenError') {
    return true
  }

  if (parsed.cause) {
    return matchesAuthError(parsed.cause)
  }

  return false
}
