import { parseError } from './errorParser'

describe('parseError', () => {
  it('handles null and undefined input', () => {
    expect(parseError(null)).toEqual({})
    expect(parseError(undefined)).toEqual({})
  })

  it('handles primitive string input', () => {
    expect(parseError('Something went wrong')).toEqual({
      message: 'Something went wrong',
    })
  })

  it('handles primitive non-string input', () => {
    expect(parseError(123)).toEqual({
      message: '123',
    })
  })

  it('extracts name and message from standard Error', () => {
    const error = new TypeError('Invalid type')
    const parsed = parseError(error)
    expect(parsed.name).toBe('TypeError')
    expect(parsed.message).toBe('Invalid type')
    expect(parsed.status).toBeUndefined()
    expect(parsed.code).toBeUndefined()
    expect(parsed.cause).toBeUndefined()
  })

  it('extracts status and code from direct properties', () => {
    const parsed = parseError({
      status: 404,
      code: 'NOT_FOUND',
      name: 'CustomError',
      message: 'Resource not found',
    })
    expect(parsed.status).toBe(404)
    expect(parsed.httpStatus).toBe(404)
    expect(parsed.code).toBe('NOT_FOUND')
    expect(parsed.name).toBe('CustomError')
    expect(parsed.message).toBe('Resource not found')
  })

  it('extracts status from statusCode and httpStatus fallbacks', () => {
    expect(parseError({ statusCode: 500 }).status).toBe(500)
    expect(parseError({ httpStatus: 502 }).status).toBe(502)
    expect(parseError({ status: '503' }).status).toBe(503)
  })

  it('extracts status and code from tRPC data envelope', () => {
    const parsed = parseError({
      data: {
        httpStatus: 401,
        code: 'UNAUTHORIZED',
      },
    })
    expect(parsed.status).toBe(401)
    expect(parsed.code).toBe('UNAUTHORIZED')
  })

  it('extracts status from tRPC shape.data envelope', () => {
    const parsed = parseError({
      shape: {
        data: {
          httpStatus: 403,
          code: 'FORBIDDEN',
        },
      },
    })
    expect(parsed.status).toBe(403)
    expect(parsed.code).toBe('FORBIDDEN')
  })

  it('recursively parses cause', () => {
    const inner = new Error('Socket closed')
    ;(inner as any).code = 'ECONNRESET'

    const outer = new Error('Request failed')
    ;(outer as any).cause = inner

    const parsed = parseError(outer)
    expect(parsed.message).toBe('Request failed')
    expect(parsed.cause).toBeDefined()
    expect(parsed.cause?.message).toBe('Socket closed')
    expect(parsed.cause?.code).toBe('ECONNRESET')
  })

  it('recursively parses nested object causes', () => {
    const error = {
      message: 'Outer',
      cause: {
        cause: {
          code: 'ECONNREFUSED',
          status: 503,
        },
      },
    }
    const parsed = parseError(error)
    expect(parsed.message).toBe('Outer')
    expect(parsed.cause?.cause?.code).toBe('ECONNREFUSED')
    expect(parsed.cause?.cause?.status).toBe(503)
  })

  it('safely handles circular cause references without hanging', () => {
    const errorA: any = new Error('Error A')
    const errorB: any = new Error('Error B')
    errorA.cause = errorB
    errorB.cause = errorA

    const parsed = parseError(errorA)
    expect(parsed.message).toBe('Error A')
    expect(parsed.cause?.message).toBe('Error B')
    expect(parsed.cause?.cause).toEqual({})
  })
})
