import { isClientOutdatedError, isRateLimitedError, parseProtocolVersion } from './protocol'

describe('parseProtocolVersion', () => {
  it('reads a positive integer header', () => {
    expect(parseProtocolVersion('3')).toBe(3)
    expect(parseProtocolVersion(['1', '2'])).toBe(2)
  })

  it('treats a missing or malformed header as version 0', () => {
    expect(parseProtocolVersion(undefined)).toBe(0)
    expect(parseProtocolVersion('')).toBe(0)
    expect(parseProtocolVersion('1.5')).toBe(0)
    expect(parseProtocolVersion('-1')).toBe(0)
    expect(parseProtocolVersion('abc')).toBe(0)
  })
})

describe('isClientOutdatedError', () => {
  it('recognises the error the server sends to outdated builds', () => {
    expect(isClientOutdatedError({ message: 'CLIENT_OUTDATED', data: { code: 'PRECONDITION_FAILED' } })).toBe(true)
  })

  it('ignores other errors', () => {
    expect(isClientOutdatedError({ message: 'CLIENT_OUTDATED', data: { code: 'UNAUTHORIZED' } })).toBe(false)
    expect(isClientOutdatedError({ message: 'Other', data: { code: 'PRECONDITION_FAILED' } })).toBe(false)
    expect(isClientOutdatedError(new Error('CLIENT_OUTDATED'))).toBe(false)
    expect(isClientOutdatedError(null)).toBe(false)
  })
})

describe('isRateLimitedError', () => {
  it('recognises errors for rate-limited requests', () => {
    expect(isRateLimitedError({ data: { code: 'TOO_MANY_REQUESTS' } })).toBe(true)
    expect(isRateLimitedError({ data: { httpStatus: 429 } })).toBe(true)
  })

  it('ignores other errors', () => {
    expect(isRateLimitedError({ data: { code: 'UNAUTHORIZED', httpStatus: 401 } })).toBe(false)
    expect(isRateLimitedError(new Error('TOO_MANY_REQUESTS'))).toBe(false)
    expect(isRateLimitedError(null)).toBe(false)
  })
})
