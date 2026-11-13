import { TRPCError } from '@trpc/server'

export interface TrpcErrorMapping {
  error: abstract new (...args: never[]) => Error
  code: TRPCError['code']
  /** Without one, the error's own message isn't sent, so that it can't leak details to the client */
  message?: string | ((error: Error) => string)
}

/**
 * Turns a domain error into the `TRPCError` of the first mapping it is an instance of, so list
 * subclasses before their base classes. Other errors come back unchanged. Use as
 * `throw toTrpcError(error, [...])`.
 *
 * The result has no cause. A mapped error is an expected outcome, and a host's error reporting may
 * treat a cause as a sign of an unexpected one (Flock's does), so a burst of lockouts or conflicts
 * would otherwise be reported, along with what the domain error's message says.
 */
export function toTrpcError(error: unknown, mappings: readonly TrpcErrorMapping[]): unknown {
  const mapping = mappings.find(m => error instanceof m.error)
  if (!mapping) {
    return error
  }

  const message = typeof mapping.message === 'function'
    ? mapping.message(error as Error)
    : mapping.message
  return message === undefined
    ? new TRPCError({ code: mapping.code })
    : new TRPCError({ code: mapping.code, message })
}
