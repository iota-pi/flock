/**
 * Version of the protocol this build speaks. Bump it with each protocol change, so that the server
 * can turn away writes from builds that predate the change (see `minProtocolVersion`).
 */
export const VAULT_PROTOCOL_VERSION = 3

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
