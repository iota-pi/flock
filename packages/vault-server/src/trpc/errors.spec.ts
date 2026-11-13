import { TRPCError } from '@trpc/server'
import { toTrpcError } from './errors'
import { AuthenticationError, ExpiredSessionError, TooManyLoginAttemptsError } from '../errors'

describe('toTrpcError', () => {
  it('maps a matching error to its code, without sending its message', () => {
    const result = toTrpcError(new AuthenticationError('No such account'), [
      { error: AuthenticationError, code: 'UNAUTHORIZED' },
    ])

    expect(result).toBeInstanceOf(TRPCError)
    expect(result).toMatchObject({ code: 'UNAUTHORIZED', message: 'UNAUTHORIZED' })
  })

  it('matches subclasses', () => {
    const result = toTrpcError(new ExpiredSessionError('Expired'), [
      { error: AuthenticationError, code: 'UNAUTHORIZED' },
    ])

    expect(result).toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('uses a fixed message, or one built from the error', () => {
    const error = new TooManyLoginAttemptsError('Slow down')

    expect(toTrpcError(error, [{ error: TooManyLoginAttemptsError, code: 'TOO_MANY_REQUESTS', message: 'Nope' }]))
      .toMatchObject({ code: 'TOO_MANY_REQUESTS', message: 'Nope' })
    expect(toTrpcError(error, [{ error: TooManyLoginAttemptsError, code: 'TOO_MANY_REQUESTS', message: e => e.message }]))
      .toMatchObject({ code: 'TOO_MANY_REQUESTS', message: 'Slow down' })
  })

  // Flock's error reporting sends errors with a cause to Sentry, so a lockout attack would flood it
  it('leaves out the cause, so that hosts treat the result as an expected error', () => {
    const withMessage = toTrpcError(new TooManyLoginAttemptsError('Slow down'), [
      { error: TooManyLoginAttemptsError, code: 'TOO_MANY_REQUESTS', message: 'Nope' },
    ])
    const withoutMessage = toTrpcError(new AuthenticationError('No such account'), [
      { error: AuthenticationError, code: 'UNAUTHORIZED' },
    ])

    expect((withMessage as TRPCError).cause).toBeUndefined()
    expect((withoutMessage as TRPCError).cause).toBeUndefined()
  })

  it('uses the first mapping that matches', () => {
    const result = toTrpcError(new ExpiredSessionError('Expired'), [
      { error: ExpiredSessionError, code: 'FORBIDDEN' },
      { error: AuthenticationError, code: 'UNAUTHORIZED' },
    ])

    expect(result).toMatchObject({ code: 'FORBIDDEN' })
  })

  it('returns other errors unchanged', () => {
    const error = new Error('DynamoDB timeout')

    expect(toTrpcError(error, [{ error: AuthenticationError, code: 'UNAUTHORIZED' }])).toBe(error)
    expect(toTrpcError('not an error', [{ error: AuthenticationError, code: 'UNAUTHORIZED' }])).toBe('not an error')
  })
})
