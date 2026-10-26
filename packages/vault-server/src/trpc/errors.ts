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
 */
export function toTrpcError(error: unknown, mappings: readonly TrpcErrorMapping[]): unknown {
  const mapping = mappings.find(m => error instanceof m.error)
  if (!mapping) {
    return error
  }

  const message = typeof mapping.message === 'function'
    ? mapping.message(error as Error)
    : mapping.message
  // Passing the cause without a message would make tRPC send the cause's message instead
  return message === undefined
    ? new TRPCError({ code: mapping.code })
    : new TRPCError({ code: mapping.code, message, cause: error })
}
