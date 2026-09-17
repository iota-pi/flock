import { parseError, type ParsedError } from './errorParser'

export function isNetworkError(error: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return true
  }

  if (!error) {
    return false
  }

  const parsed = parseError(error)
  return matchesNetworkError(parsed)
}

function matchesNetworkError(parsed: ParsedError): boolean {
  // Check error name
  const name = parsed.name ?? ''
  if (
    name === 'NetworkError' ||
    name === 'FetchError' ||
    name === 'AbortError' ||
    name === 'TimeoutError'
  ) {
    return true
  }

  // Check HTTP status (from TRPC error data or response)
  const httpStatus = parsed.status
  if (
    httpStatus === 502 ||
    httpStatus === 503 ||
    httpStatus === 504 ||
    httpStatus === 408 ||
    httpStatus === 429
  ) {
    return true
  }

  // Check error code
  const code = parsed.code
  if (code && typeof code === 'string') {
    const upperCode = code.toUpperCase()
    if (
      upperCode === 'ECONNREFUSED' ||
      upperCode === 'ECONNRESET' ||
      upperCode === 'ETIMEDOUT' ||
      upperCode === 'ENOTFOUND' ||
      upperCode === 'EAI_AGAIN' ||
      upperCode === 'TIMEOUT' ||
      upperCode === 'NETWORK_ERROR'
    ) {
      return true
    }
  }

  // Check error message
  const message = typeof parsed.message === 'string' ? parsed.message.toLowerCase() : ''
  if (isNetworkErrorMessage(message)) {
    return true
  }

  // Check cause recursively
  if (parsed.cause) {
    return matchesNetworkError(parsed.cause)
  }

  return false
}

function isNetworkErrorMessage(message: string): boolean {
  if (!message) return false
  return (
    message.includes('failed to fetch') ||
    message.includes('networkerror') ||
    message.includes('network error') ||
    message.includes('the network connection was lost') ||
    message.includes('the internet connection appears to be offline') ||
    message.includes('load failed') ||
    message.includes('fetch failed') ||
    message.includes('net::err') ||
    message.includes('econnrefused') ||
    message.includes('econnreset') ||
    message.includes('etimedout') ||
    message.includes('enotfound') ||
    message.includes('socket hang up') ||
    message.includes('connection refused') ||
    message.includes('connection reset') ||
    message.includes('connection timed out') ||
    message.includes('timed out') ||
    message.includes('timeout') ||
    message.includes('offline') ||
    message.includes('gateway timeout') ||
    message.includes('bad gateway')
  )
}
