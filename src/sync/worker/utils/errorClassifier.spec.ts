import {
  classifySyncError,
  ErrorClassifier,
  TRANSIENT_VAULT_ERROR_SUBSTRINGS,
  isAuthError,
  isNetworkError,
  isServerError,
  isTransientVaultError,
} from './errorClassifier'
import { AbortError } from './abort'
import { MissingKeyError } from './decryptWithKeyResolution'
import { VaultNotInitializedError } from 'src/api/vault'

describe('classifySyncError & ErrorClassifier', () => {
  describe('null, undefined, and non-error inputs', () => {
    it('handles null and undefined', () => {
      const resNull = classifySyncError(null)
      expect(resNull).toEqual({
        isAbort: false,
        isAuth: false,
        isNetwork: false,
        isServerError: false,
        isTransientVault: false,
        isMissingKey: false,
        status: undefined,
        message: '',
      })

      const resUndef = ErrorClassifier.classify(undefined)
      expect(resUndef).toEqual({
        isAbort: false,
        isAuth: false,
        isNetwork: false,
        isServerError: false,
        isTransientVault: false,
        isMissingKey: false,
        status: undefined,
        message: '',
      })
    })

    it('handles primitive string message', () => {
      const res = classifySyncError('Something went wrong')
      expect(res.message).toBe('Something went wrong')
      expect(res.isAuth).toBe(false)
      expect(res.isServerError).toBe(false)
    })
  })

  describe('offline state', () => {
    it('sets isNetwork to true when navigator.onLine is false', () => {
      const originalNavigator = globalThis.navigator
      try {
        Object.defineProperty(globalThis, 'navigator', {
          value: { onLine: false },
          configurable: true,
          writable: true,
        })
        expect(classifySyncError(null).isNetwork).toBe(true)
        expect(classifySyncError(new Error('Random failure')).isNetwork).toBe(true)
      } finally {
        Object.defineProperty(globalThis, 'navigator', {
          value: originalNavigator,
          configurable: true,
          writable: true,
        })
      }
    })
  })

  describe('abort errors', () => {
    it('identifies AbortError instance', () => {
      const classified = classifySyncError(new AbortError('User cancelled'))
      expect(classified.isAbort).toBe(true)
      expect(classified.message).toBe('User cancelled')
    })

    it('identifies error with name AbortError or TimeoutError', () => {
      const abortErr = new Error('aborted')
      abortErr.name = 'AbortError'
      expect(classifySyncError(abortErr).isAbort).toBe(true)

      const timeoutErr = new Error('timeout')
      timeoutErr.name = 'TimeoutError'
      expect(classifySyncError(timeoutErr).isAbort).toBe(true)
    })

    it('identifies DOMException AbortError', () => {
      const domErr = new DOMException('aborted', 'AbortError')
      expect(classifySyncError(domErr).isAbort).toBe(true)
    })

    it('identifies nested cause abort error', () => {
      const outer = new Error('Worker stopped', { cause: new AbortError() })
      expect(classifySyncError(outer).isAbort).toBe(true)
    })
  })

  describe('auth errors', () => {
    it('identifies 401 and 403 HTTP status', () => {
      expect(classifySyncError({ httpStatus: 401 }).isAuth).toBe(true)
      expect(classifySyncError({ status: 403 }).isAuth).toBe(true)
      expect(classifySyncError({ statusCode: 401 }).isAuth).toBe(true)
      expect(classifySyncError({ data: { httpStatus: 401 } }).isAuth).toBe(true)
      expect(classifySyncError({ shape: { data: { httpStatus: 403 } } }).isAuth).toBe(true)
    })

    it('identifies UNAUTHORIZED and FORBIDDEN codes', () => {
      expect(classifySyncError({ code: 'UNAUTHORIZED' }).isAuth).toBe(true)
      expect(classifySyncError({ data: { code: 'FORBIDDEN' } }).isAuth).toBe(true)
    })

    it('identifies auth-specific error names', () => {
      const unauth = new Error('Not logged in')
      unauth.name = 'UnauthorizedError'
      expect(classifySyncError(unauth).isAuth).toBe(true)

      const forbidden = new Error('Access denied')
      forbidden.name = 'ForbiddenError'
      expect(classifySyncError(forbidden).isAuth).toBe(true)

      const expired = new Error('Session expired')
      expired.name = 'AuthExpiredError'
      expect(classifySyncError(expired).isAuth).toBe(true)
    })

    it('rejects primitives and unrelated errors containing unauthorized text', () => {
      expect(classifySyncError('Unauthorized').isAuth).toBe(false)
      expect(classifySyncError(401).isAuth).toBe(false)
      expect(classifySyncError(new Error('unauthorized access to proxy')).isAuth).toBe(false)
    })

    it('identifies auth error in nested cause', () => {
      const outer = new Error('Request failed', { cause: { httpStatus: 401 } })
      const classified = classifySyncError(outer)
      expect(classified.isAuth).toBe(true)
      expect(classified.status).toBe(401)
    })
  })

  describe('network errors', () => {
    it('detects standard fetch error messages', () => {
      expect(classifySyncError(new TypeError('Failed to fetch')).isNetwork).toBe(true)
      expect(classifySyncError(new Error('The network connection was lost.')).isNetwork).toBe(true)
      expect(classifySyncError(new Error('net::ERR_INTERNET_DISCONNECTED')).isNetwork).toBe(true)
      expect(classifySyncError(new Error('socket hang up')).isNetwork).toBe(true)
    })

    it('detects transient network HTTP statuses', () => {
      expect(classifySyncError({ httpStatus: 502 }).isNetwork).toBe(true)
      expect(classifySyncError({ httpStatus: 503 }).isNetwork).toBe(true)
      expect(classifySyncError({ httpStatus: 504 }).isNetwork).toBe(true)
      expect(classifySyncError({ httpStatus: 408 }).isNetwork).toBe(true)
      expect(classifySyncError({ httpStatus: 429 }).isNetwork).toBe(true)
    })

    it('detects network error codes', () => {
      expect(classifySyncError({ code: 'ECONNREFUSED' }).isNetwork).toBe(true)
      expect(classifySyncError({ code: 'ECONNRESET' }).isNetwork).toBe(true)
      expect(classifySyncError({ code: 'ETIMEDOUT' }).isNetwork).toBe(true)
      expect(classifySyncError({ code: 'ENOTFOUND' }).isNetwork).toBe(true)
    })

    it('identifies network error in nested cause', () => {
      const outer = new Error('RPC error', { cause: new TypeError('Failed to fetch') })
      expect(classifySyncError(outer).isNetwork).toBe(true)
    })
  })

  describe('server errors', () => {
    it('detects 5xx HTTP statuses', () => {
      expect(classifySyncError({ httpStatus: 500 }).isServerError).toBe(true)
      expect(classifySyncError({ httpStatus: 502 }).isServerError).toBe(true)
      expect(classifySyncError({ httpStatus: 503 }).isServerError).toBe(true)
      expect(classifySyncError({ httpStatus: 599 }).isServerError).toBe(true)
      expect(classifySyncError({ httpStatus: 400 }).isServerError).toBe(false)
    })

    it('detects server error codes and names', () => {
      expect(classifySyncError({ code: 'INTERNAL_SERVER_ERROR' }).isServerError).toBe(true)
      expect(classifySyncError({ code: 'SERVER_ERROR' }).isServerError).toBe(true)

      const internalErr = new Error('fail')
      internalErr.name = 'InternalServerError'
      expect(classifySyncError(internalErr).isServerError).toBe(true)
    })

    it('detects server error messages and primitives', () => {
      expect(classifySyncError(new Error('Internal server error')).isServerError).toBe(true)
      expect(classifySyncError(new Error('503 Service Unavailable')).isServerError).toBe(true)
      expect(classifySyncError('Internal Server Error').isServerError).toBe(true)
    })

    it('identifies server error in nested cause', () => {
      const outer = new Error('Outer', { cause: { status: 500 } })
      expect(classifySyncError(outer).isServerError).toBe(true)
    })
  })

  describe('transient vault errors', () => {
    it('identifies VaultNotInitializedError instance and name', () => {
      expect(classifySyncError(new VaultNotInitializedError()).isTransientVault).toBe(true)
      const err = new Error('Not ready')
      err.name = 'VaultNotInitializedError'
      expect(classifySyncError(err).isTransientVault).toBe(true)
    })

    it('identifies substrings in error message and string primitive', () => {
      for (const substring of TRANSIENT_VAULT_ERROR_SUBSTRINGS) {
        expect(classifySyncError(new Error(`Prefix ${substring.toUpperCase()} suffix`)).isTransientVault).toBe(true)
        expect(classifySyncError(`Raw string containing ${substring}`).isTransientVault).toBe(true)
        expect(classifySyncError({ message: `Object with ${substring}` }).isTransientVault).toBe(true)
      }
    })

    it('identifies transient vault error in nested cause', () => {
      const outer = new Error('Snapshot failure', {
        cause: new Error('Mid failure', { cause: new VaultNotInitializedError() }),
      })
      expect(classifySyncError(outer).isTransientVault).toBe(true)
    })
  })

  describe('missing key errors', () => {
    it('identifies MissingKeyError instance and extracts kver', () => {
      const err = new MissingKeyError('k2', 'Key missing')
      const classified = classifySyncError(err)
      expect(classified.isMissingKey).toBe(true)
      expect(classified.kver).toBe('k2')
      expect(classified.message).toBe('Key missing')
    })

    it('identifies duck-typed MissingKeyError and extracts kver', () => {
      const duckTyped = { name: 'MissingKeyError', kver: 'k3', message: 'Missing key 3' }
      const classified = classifySyncError(duckTyped)
      expect(classified.isMissingKey).toBe(true)
      expect(classified.kver).toBe('k3')
    })

    it('identifies missing key in nested cause', () => {
      const outer = new Error('Decryption failed', { cause: new MissingKeyError('k4') })
      const classified = classifySyncError(outer)
      expect(classified.isMissingKey).toBe(true)
      expect(classified.kver).toBe('k4')
    })
  })

  describe('multi-flag classification in a single pass', () => {
    it('classifies 503 error as both server error and network error', () => {
      const err = { httpStatus: 503, message: '503 Service Unavailable' }
      const classified = classifySyncError(err)
      expect(classified.isServerError).toBe(true)
      expect(classified.isNetwork).toBe(true)
      expect(classified.isAuth).toBe(false)
      expect(classified.status).toBe(503)
      expect(classified.message).toBe('503 Service Unavailable')
    })

    it('correctly maps ErrorClassifier.classify to classifySyncError', () => {
      const err = new Error('Test')
      expect(ErrorClassifier.classify(err)).toEqual(classifySyncError(err))
    })
  })
})

describe('convenience error predicate helpers', () => {
  describe('isAuthError', () => {
    it('returns false for null, undefined, and non-object inputs', () => {
      expect(isAuthError(null)).toBe(false)
      expect(isAuthError(undefined)).toBe(false)
      expect(isAuthError('Unauthorized')).toBe(false)
      expect(isAuthError(401)).toBe(false)
    })

    it('detects 401 and 403 status codes', () => {
      expect(isAuthError({ httpStatus: 401 })).toBe(true)
      expect(isAuthError({ httpStatus: 403 })).toBe(true)
      expect(isAuthError({ status: 401 })).toBe(true)
      expect(isAuthError({ status: 403 })).toBe(true)
      expect(isAuthError({ statusCode: 401 })).toBe(true)
      expect(isAuthError({ statusCode: 403 })).toBe(true)
    })

    it('detects 401 and 403 in tRPC error structures', () => {
      expect(isAuthError({ data: { httpStatus: 401 } })).toBe(true)
      expect(isAuthError({ shape: { data: { httpStatus: 403 } } })).toBe(true)
    })

    it('returns false for non-auth HTTP status codes', () => {
      expect(isAuthError({ httpStatus: 200 })).toBe(false)
      expect(isAuthError({ httpStatus: 400 })).toBe(false)
      expect(isAuthError({ httpStatus: 404 })).toBe(false)
      expect(isAuthError({ httpStatus: 500 })).toBe(false)
    })

    it('detects auth error codes', () => {
      expect(isAuthError({ code: 'UNAUTHORIZED' })).toBe(true)
      expect(isAuthError({ code: 'FORBIDDEN' })).toBe(true)
      expect(isAuthError({ data: { code: 'UNAUTHORIZED' } })).toBe(true)
      expect(isAuthError({ data: { code: 'FORBIDDEN' } })).toBe(true)

      expect(isAuthError({ code: 'INTERNAL_SERVER_ERROR' })).toBe(false)
      expect(isAuthError({ code: 'BAD_REQUEST' })).toBe(false)
    })

    it('detects auth error names', () => {
      const unauthErr = new Error('Unauthorized')
      unauthErr.name = 'UnauthorizedError'
      expect(isAuthError(unauthErr)).toBe(true)

      const forbiddenErr = new Error('Forbidden')
      forbiddenErr.name = 'ForbiddenError'
      expect(isAuthError(forbiddenErr)).toBe(true)

      const authExpiredErr = new Error('Session expired')
      authExpiredErr.name = 'AuthExpiredError'
      expect(isAuthError(authExpiredErr)).toBe(true)

      const authErr = new Error('No active session token available')
      authErr.name = 'AuthError'
      expect(isAuthError(authErr)).toBe(true)

      const otherErr = new Error('Generic')
      otherErr.name = 'Error'
      expect(isAuthError(otherErr)).toBe(false)
    })

    it('does not classify unstructured error messages as auth errors', () => {
      expect(isAuthError(new Error('Network proxy error: unauthorized gateway access'))).toBe(false)
      expect(isAuthError(new Error('Forbidden action encountered'))).toBe(false)
    })

    it('recursively inspects cause', () => {
      const wrappedError = new Error('Request failed')
      ;(wrappedError as any).cause = { httpStatus: 401 }
      expect(isAuthError(wrappedError)).toBe(true)

      const deeplyNested = new Error('Outer')
      ;(deeplyNested as any).cause = {
        cause: {
          code: 'FORBIDDEN',
        },
      }
      expect(isAuthError(deeplyNested)).toBe(true)
    })
  })

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

  describe('isServerError', () => {
    it('returns false for null, undefined, and non-server errors', () => {
      expect(isServerError(null)).toBe(false)
      expect(isServerError(undefined)).toBe(false)
      expect(isServerError(new Error('Validation failed'))).toBe(false)
      expect(isServerError(new TypeError('Failed to fetch'))).toBe(false)
    })

    it('detects 5xx HTTP status codes', () => {
      expect(isServerError({ httpStatus: 500 })).toBe(true)
      expect(isServerError({ httpStatus: 502 })).toBe(true)
      expect(isServerError({ httpStatus: 503 })).toBe(true)
      expect(isServerError({ httpStatus: 504 })).toBe(true)
      expect(isServerError({ status: 500 })).toBe(true)
      expect(isServerError({ statusCode: 500 })).toBe(true)

      // TRPC error shapes
      expect(isServerError({ data: { httpStatus: 500 } })).toBe(true)
      expect(isServerError({ shape: { data: { httpStatus: 503 } } })).toBe(true)

      // Non-5xx status codes
      expect(isServerError({ httpStatus: 400 })).toBe(false)
      expect(isServerError({ httpStatus: 401 })).toBe(false)
      expect(isServerError({ httpStatus: 403 })).toBe(false)
      expect(isServerError({ httpStatus: 404 })).toBe(false)
      expect(isServerError({ httpStatus: 429 })).toBe(false)
    })

    it('detects server error codes', () => {
      expect(isServerError({ code: 'INTERNAL_SERVER_ERROR' })).toBe(true)
      expect(isServerError({ code: 'SERVER_ERROR' })).toBe(true)
      expect(isServerError({ data: { code: 'INTERNAL_SERVER_ERROR' } })).toBe(true)

      expect(isServerError({ code: 'UNAUTHORIZED' })).toBe(false)
      expect(isServerError({ code: 'BAD_REQUEST' })).toBe(false)
      expect(isServerError({ code: 'TIMEOUT' })).toBe(false)
    })

    it('detects server error names', () => {
      const internalErr = new Error('custom')
      internalErr.name = 'InternalServerError'
      expect(isServerError(internalErr)).toBe(true)

      const serverErr = new Error('custom')
      serverErr.name = 'ServerError'
      expect(isServerError(serverErr)).toBe(true)
    })

    it('detects standard server error messages', () => {
      expect(isServerError(new Error('Internal server error'))).toBe(true)
      expect(isServerError(new Error('Server error occurred while writing'))).toBe(true)
      expect(isServerError(new Error('503 Service Unavailable'))).toBe(true)
      expect(isServerError(new Error('502 Bad Gateway'))).toBe(true)
      expect(isServerError(new Error('504 Gateway Timeout'))).toBe(true)
      expect(isServerError('Internal Server Error')).toBe(true)
    })

    it('recursively inspects cause', () => {
      const wrappedError = new Error('Operation failed')
      ;(wrappedError as any).cause = { data: { httpStatus: 500 } }

      expect(isServerError(wrappedError)).toBe(true)

      const nestedError = new Error('Outer error')
      ;(nestedError as any).cause = { cause: { code: 'INTERNAL_SERVER_ERROR' } }

      expect(isServerError(nestedError)).toBe(true)
    })
  })

  describe('isTransientVaultError', () => {
    it('returns false for falsy values', () => {
      expect(isTransientVaultError(null)).toBe(false)
      expect(isTransientVaultError(undefined)).toBe(false)
      expect(isTransientVaultError('')).toBe(false)
    })

    it('returns true for VaultNotInitializedError instance or error with that name', () => {
      expect(isTransientVaultError(new VaultNotInitializedError())).toBe(true)
      const err = new Error('Some message')
      err.name = 'VaultNotInitializedError'
      expect(isTransientVaultError(err)).toBe(true)

      const duckTypedErr = { name: 'VaultNotInitializedError' }
      expect(isTransientVaultError(duckTypedErr)).toBe(true)
    })

    it('returns true for each substring in TRANSIENT_VAULT_ERROR_SUBSTRINGS', () => {
      for (const substring of TRANSIENT_VAULT_ERROR_SUBSTRINGS) {
        expect(isTransientVaultError(new Error(`Prefix ${substring.toUpperCase()} suffix`))).toBe(true)
        expect(isTransientVaultError(`Raw string containing ${substring}`)).toBe(true)
        expect(isTransientVaultError({ message: `Object with ${substring}` })).toBe(true)
      }
    })

    it('returns true for wrapped errors with cause', () => {
      const rootErr = new Error('Vault is locked')
      const wrappedErr = new Error('Snapshot preparation failed', { cause: rootErr })
      expect(isTransientVaultError(wrappedErr)).toBe(true)

      const deepWrappedErr = new Error('Outer error', {
        cause: new Error('Mid error', { cause: new VaultNotInitializedError() }),
      })
      expect(isTransientVaultError(deepWrappedErr)).toBe(true)
    })

    it('returns false for non-transient errors', () => {
      expect(isTransientVaultError(new Error('Corrupt block detected'))).toBe(false)
      expect(isTransientVaultError(new Error('Permission denied'))).toBe(false)
      expect(isTransientVaultError('Unexpected EOF')).toBe(false)
      expect(isTransientVaultError({ message: 'Network timeout' })).toBe(false)
    })
  })
})

