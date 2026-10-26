import { TRPCError } from '@trpc/server'
import { toTrpcError } from './errors'
import { AuthenticationError, ExpiredSessionError, InvalidPageTokenError } from '../errors'

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
    const error = new InvalidPageTokenError('Bad token')

    expect(toTrpcError(error, [{ error: InvalidPageTokenError, code: 'BAD_REQUEST', message: 'Nope' }]))
      .toMatchObject({ code: 'BAD_REQUEST', message: 'Nope', cause: error })
    expect(toTrpcError(error, [{ error: InvalidPageTokenError, code: 'BAD_REQUEST', message: e => e.message }]))
      .toMatchObject({ code: 'BAD_REQUEST', message: 'Bad token', cause: error })
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
