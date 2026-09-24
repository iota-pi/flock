import {
  classifySyncError,
  ErrorClassifier,
  TRANSIENT_VAULT_ERROR_SUBSTRINGS,
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
