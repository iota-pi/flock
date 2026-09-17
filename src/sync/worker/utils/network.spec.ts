import { isNetworkError } from './network'

describe('isNetworkError', () => {
  it('returns true when navigator.onLine is false', () => {
    const originalNavigator = globalThis.navigator
    try {
      Object.defineProperty(globalThis, 'navigator', {
        value: { onLine: false },
        configurable: true,
        writable: true,
      })
      expect(isNetworkError(new Error('something else'))).toBe(true)
      expect(isNetworkError(null)).toBe(true)
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        value: originalNavigator,
        configurable: true,
        writable: true,
      })
    }
  })

  it('returns false for null, undefined, and non-network errors', () => {
    expect(isNetworkError(null)).toBe(false)
    expect(isNetworkError(undefined)).toBe(false)
    expect(isNetworkError(new Error('Corrupt document binary'))).toBe(false)
    expect(isNetworkError(new Error('Validation failed'))).toBe(false)
  })

  it('detects standard fetch and network error messages', () => {
    expect(isNetworkError(new TypeError('Failed to fetch'))).toBe(true)
    expect(isNetworkError(new Error('NetworkError when attempting to fetch resource.'))).toBe(true)
    expect(isNetworkError(new Error('The network connection was lost.'))).toBe(true)
    expect(isNetworkError(new Error('The Internet connection appears to be offline.'))).toBe(true)
    expect(isNetworkError(new Error('TypeError: fetch failed'))).toBe(true)
    expect(isNetworkError(new Error('Load failed'))).toBe(true)
    expect(isNetworkError(new Error('network error'))).toBe(true)
    expect(isNetworkError(new Error('socket hang up'))).toBe(true)
    expect(isNetworkError(new Error('net::ERR_INTERNET_DISCONNECTED'))).toBe(true)
  })

  it('detects network error names', () => {
    const netErr = new Error('custom')
    netErr.name = 'NetworkError'
    expect(isNetworkError(netErr)).toBe(true)

    const fetchErr = new Error('custom')
    fetchErr.name = 'FetchError'
    expect(isNetworkError(fetchErr)).toBe(true)

    const abortErr = new Error('aborted')
    abortErr.name = 'AbortError'
    expect(isNetworkError(abortErr)).toBe(true)

    const timeoutErr = new Error('timed out')
    timeoutErr.name = 'TimeoutError'
    expect(isNetworkError(timeoutErr)).toBe(true)
  })

  it('detects transient HTTP status codes', () => {
    expect(isNetworkError({ httpStatus: 502 })).toBe(true)
    expect(isNetworkError({ httpStatus: 503 })).toBe(true)
    expect(isNetworkError({ httpStatus: 504 })).toBe(true)
    expect(isNetworkError({ httpStatus: 408 })).toBe(true)
    expect(isNetworkError({ httpStatus: 429 })).toBe(true)

    // TRPC error shape
    expect(isNetworkError({ data: { httpStatus: 503 } })).toBe(true)
    expect(isNetworkError({ shape: { data: { httpStatus: 502 } } })).toBe(true)

    // Non-network HTTP status codes
    expect(isNetworkError({ httpStatus: 400 })).toBe(false)
    expect(isNetworkError({ httpStatus: 401 })).toBe(false)
    expect(isNetworkError({ httpStatus: 403 })).toBe(false)
    expect(isNetworkError({ httpStatus: 404 })).toBe(false)
  })

  it('detects network error codes', () => {
    expect(isNetworkError({ code: 'ECONNREFUSED' })).toBe(true)
    expect(isNetworkError({ code: 'ECONNRESET' })).toBe(true)
    expect(isNetworkError({ code: 'ETIMEDOUT' })).toBe(true)
    expect(isNetworkError({ code: 'ENOTFOUND' })).toBe(true)
    expect(isNetworkError({ code: 'EAI_AGAIN' })).toBe(true)
    expect(isNetworkError({ code: 'TIMEOUT' })).toBe(true)
    expect(isNetworkError({ data: { code: 'NETWORK_ERROR' } })).toBe(true)

    expect(isNetworkError({ code: 'UNAUTHORIZED' })).toBe(false)
    expect(isNetworkError({ code: 'BAD_REQUEST' })).toBe(false)
  })

  it('recursively inspects cause', () => {
    const wrappedError = new Error('TRPC invocation failed')
    ;(wrappedError as any).cause = new TypeError('Failed to fetch')

    expect(isNetworkError(wrappedError)).toBe(true)

    const nestedError = new Error('Outer error')
    ;(nestedError as any).cause = { cause: { code: 'ECONNREFUSED' } }

    expect(isNetworkError(nestedError)).toBe(true)
  })
})
