export function isNetworkError(error: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return true
  }

  if (!error) {
    return false
  }

  if (typeof error !== 'object') {
    return isNetworkErrorMessage(String(error).toLowerCase())
  }

  const anyError = error as { [key: string]: unknown }

  // Check error name
  const name = typeof anyError.name === 'string' ? anyError.name : ''
  if (
    name === 'NetworkError' ||
    name === 'FetchError' ||
    name === 'AbortError' ||
    name === 'TimeoutError'
  ) {
    return true
  }

  // Check HTTP status (from TRPC error data or response)
  const data = (anyError.data || (anyError as { shape?: { data?: unknown } }).shape?.data) as
    | { httpStatus?: number; code?: string }
    | undefined
  const httpStatus =
    data?.httpStatus ??
    (anyError.httpStatus as number | undefined) ??
    (anyError.status as number | undefined) ??
    (anyError.statusCode as number | undefined)

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
  const code = (data?.code ?? anyError.code) as string | undefined
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
  const message = typeof anyError.message === 'string' ? anyError.message.toLowerCase() : ''
  if (isNetworkErrorMessage(message)) {
    return true
  }

  // Check cause recursively
  if (anyError.cause) {
    return isNetworkError(anyError.cause)
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
