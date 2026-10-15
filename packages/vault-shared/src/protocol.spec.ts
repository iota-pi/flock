import { isClientOutdatedError, parseProtocolVersion } from './protocol'

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
