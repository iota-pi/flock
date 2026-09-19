import { isAuthError } from './auth'

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
