/**
 * Version of the protocol this build speaks. Bump it with each protocol change, so that the server
 * can turn away writes from builds that predate the change (see `minProtocolVersion`).
 */
export const VAULT_PROTOCOL_VERSION = 4

/** Request header carrying the client's protocol version. Builds that don't send it count as version 0. */
export const PROTOCOL_VERSION_HEADER = 'x-vault-protocol'

/** Message of the error the server returns for a write from a build below its minimum protocol version */
export const CLIENT_OUTDATED_MESSAGE = 'CLIENT_OUTDATED'

export function parseProtocolVersion(header: string | string[] | undefined): number {
  const value = Array.isArray(header) ? header[header.length - 1] : header
  const version = Number(value)
  return Number.isInteger(version) && version > 0 ? version : 0
}

export function isClientOutdatedError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const { message, data } = error as { message?: unknown, data?: { code?: unknown } }
  return message === CLIENT_OUTDATED_MESSAGE && data?.code === 'PRECONDITION_FAILED'
}

/** Message of the error the server returns for a login to an account with too many recent failed logins */
export const TOO_MANY_REQUESTS_MESSAGE = 'TOO_MANY_REQUESTS'

/** Whether the server turned a request down for being over a rate limit (HTTP 429) */
export function isRateLimitedError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const { data } = error as { data?: { code?: unknown, httpStatus?: unknown } }
  return data?.code === 'TOO_MANY_REQUESTS' || data?.httpStatus === 429
}

/** Whether the server answered that what was asked for doesn't exist (HTTP 404), such as an unknown account */
export function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const { data } = error as { data?: { code?: unknown, httpStatus?: unknown } }
  return data?.code === 'NOT_FOUND' || data?.httpStatus === 404
}
