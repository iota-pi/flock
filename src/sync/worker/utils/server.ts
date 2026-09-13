import { parseError, type ParsedError } from './errorParser'

export function isServerError(error: unknown): boolean {
  if (!error) {
    return false
  }

  const parsed = parseError(error)
  return matchesServerError(parsed)
}

function matchesServerError(parsed: ParsedError): boolean {
  // Check error name
  const name = parsed.name ?? ''
  if (name === 'InternalServerError' || name === 'ServerError') {
    return true
  }

  // Check HTTP status (from TRPC error data or response)
  const httpStatus = parsed.status
  if (httpStatus !== undefined && httpStatus >= 500 && httpStatus <= 599) {
    return true
  }

  // Check error code
  const code = parsed.code
  if (code && typeof code === 'string') {
    const upperCode = code.toUpperCase()
    if (upperCode === 'INTERNAL_SERVER_ERROR' || upperCode === 'SERVER_ERROR') {
      return true
    }
  }

  // Check error message
  const message = typeof parsed.message === 'string' ? parsed.message.toLowerCase() : ''
  if (isServerErrorMessage(message)) {
    return true
  }

  // Check cause recursively
  if (parsed.cause) {
    return matchesServerError(parsed.cause)
  }

  return false
}

function isServerErrorMessage(message: string): boolean {
  if (!message) return false
  return (
    message.includes('internal server error') ||
    message.includes('server error') ||
    message.includes('service unavailable') ||
    message.includes('bad gateway') ||
    message.includes('gateway timeout')
  )
}
