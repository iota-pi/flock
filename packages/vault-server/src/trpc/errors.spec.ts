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

  it('uses a fixed message, or one built from the error, and keeps the cause', () => {
    const error = new TooManyLoginAttemptsError('Slow down')

    expect(toTrpcError(error, [{ error: TooManyLoginAttemptsError, code: 'TOO_MANY_REQUESTS', message: 'Nope' }]))
      .toMatchObject({ code: 'TOO_MANY_REQUESTS', message: 'Nope', cause: error })
    expect(toTrpcError(error, [{ error: TooManyLoginAttemptsError, code: 'TOO_MANY_REQUESTS', message: e => e.message }]))
      .toMatchObject({ code: 'TOO_MANY_REQUESTS', message: 'Slow down', cause: error })
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
