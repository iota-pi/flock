import { isServerError } from './server'

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
