import { getOnlineState } from './onlineStatus'
import { isAbortError } from './abort'

export interface ClassifiedError {
  isAbort: boolean
  isAuth: boolean
  isNetwork: boolean
  isServerError: boolean
  isTransientVault: boolean
  isMissingKey: boolean
  status?: number
  message: string
  kver?: string
}

export const TRANSIENT_VAULT_ERROR_SUBSTRINGS = [
  'vault is locked',
  'vaultnotinitializederror',
  'not initialized',
  'active key not found',
] as const

const NETWORK_ERROR_NAMES = new Set([
  'NetworkError',
  'FetchError',
  'AbortError',
  'TimeoutError',
])

const NETWORK_HTTP_STATUSES = new Set([502, 503, 504, 408, 429])

const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'TIMEOUT',
  'NETWORK_ERROR',
])

const NETWORK_ERROR_SUBSTRINGS = [
  'failed to fetch',
  'networkerror',
  'network error',
  'the network connection was lost',
  'the internet connection appears to be offline',
  'load failed',
  'fetch failed',
  'net::err',
  'econnrefused',
  'econnreset',
  'etimedout',
  'enotfound',
  'socket hang up',
  'connection refused',
  'connection reset',
  'connection timed out',
  'timed out',
  'timeout',
  'offline',
  'gateway timeout',
  'bad gateway',
] as const

const SERVER_ERROR_NAMES = new Set(['InternalServerError', 'ServerError'])

const SERVER_ERROR_CODES = new Set(['INTERNAL_SERVER_ERROR', 'SERVER_ERROR'])

const SERVER_ERROR_SUBSTRINGS = [
  'internal server error',
  'server error',
  'service unavailable',
  'bad gateway',
  'gateway timeout',
] as const

/** The status and tRPC code the server sends when it rejects a request's credentials */
export const SESSION_REJECTED_STATUS = 401
export const SESSION_REJECTED_CODE = 'UNAUTHORIZED'

// The server never sends 403 or FORBIDDEN, but backing off sync is cheap, so treat them as auth too
const AUTH_HTTP_STATUSES = new Set([SESSION_REJECTED_STATUS, 403])

const AUTH_ERROR_CODES = new Set([SESSION_REJECTED_CODE, 'FORBIDDEN'])

const AUTH_ERROR_NAMES = new Set([
  'UnauthorizedError',
  'ForbiddenError',
  'AuthExpiredError',
  'AuthError',
])

interface ParsedError {
  status?: number
  code?: string
  name?: string
  message?: string
  kver?: string
  cause?: ParsedError
}

/**
 * Normalizes an unknown error value into a ParsedError, reading the status and code from a tRPC
 * `data` (or `shape.data`) envelope first, and unwrapping nested causes (cycles end in `{}`).
 */
function parseError(error: unknown, seen = new WeakSet<object>()): ParsedError {
  if (!error) {
    return {}
  }

  if (typeof error !== 'object') {
    return {
      message: String(error),
    }
  }

  if (seen.has(error)) {
    return {}
  }
  seen.add(error)

  const anyError = error as { [key: string]: unknown }

  const name = typeof anyError.name === 'string' ? anyError.name : undefined
  const message = typeof anyError.message === 'string' ? anyError.message : undefined

  const data = (anyError.data || (anyError as { shape?: { data?: unknown } }).shape?.data) as
    | { [key: string]: unknown }
    | undefined

  const rawStatus =
    data?.httpStatus ??
    data?.status ??
    data?.statusCode ??
    anyError.httpStatus ??
    anyError.status ??
    anyError.statusCode

  let status: number | undefined
  if (typeof rawStatus === 'number' && Number.isFinite(rawStatus)) {
    status = rawStatus
  } else if (typeof rawStatus === 'string' && /^\d+$/.test(rawStatus)) {
    const parsed = parseInt(rawStatus, 10)
    if (!Number.isNaN(parsed)) {
      status = parsed
    }
  }

  const rawCode = data?.code ?? anyError.code
  const code = typeof rawCode === 'string' ? rawCode : undefined

  const rawKver = anyError.kver
  const kver = typeof rawKver === 'string' ? rawKver : undefined

  const cause = anyError.cause != null ? parseError(anyError.cause, seen) : undefined

  return {
    status,
    code,
    name,
    message,
    kver,
    cause,
  }
}

/**
 * Classifies an unknown error into declarative boolean flags, status, and message.
 * Inspects parsed error data and its cause chain in a single pass.
 */
export function classifySyncError(error: unknown): ClassifiedError {
  const isOffline = !getOnlineState()

  if (!error) {
    return {
      isAbort: false,
      isAuth: false,
      isNetwork: isOffline,
      isServerError: false,
      isTransientVault: false,
      isMissingKey: false,
      status: undefined,
      message: '',
    }
  }

  const parsed = parseError(error)

  let isAbort = isAbortError(error)
  let isAuth = false
  let isNetwork = isOffline
  let isServerError = false
  let isTransientVault = false
  let isMissingKey = false
  let missingKver: string | undefined

  let status = parsed.status
  const message = parsed.message ?? ''

  const isObjectError = typeof error === 'object' && error !== null

  let current: ParsedError | undefined = parsed
  let depth = 0
  const maxDepth = 20

  while (current && depth < maxDepth) {
    if (status === undefined && current.status !== undefined) {
      status = current.status
    }

    const currentName = current.name ?? ''
    const currentCode = current.code ? current.code.toUpperCase() : ''
    const currentStatus = current.status
    const currentMessage = typeof current.message === 'string' ? current.message.toLowerCase() : ''

    // 1. Abort
    if (!isAbort) {
      if (currentName === 'AbortError' || currentName === 'TimeoutError') {
        isAbort = true
      }
    }

    // 2. Auth (only checked for object-based errors)
    if (!isAuth && isObjectError) {
      if (
        (currentStatus !== undefined && AUTH_HTTP_STATUSES.has(currentStatus)) ||
        (currentCode && AUTH_ERROR_CODES.has(currentCode)) ||
        (currentName && AUTH_ERROR_NAMES.has(currentName))
      ) {
        isAuth = true
      }
    }

    // 3. Network
    if (!isNetwork) {
      if (
        (currentName && NETWORK_ERROR_NAMES.has(currentName)) ||
        (currentStatus !== undefined && NETWORK_HTTP_STATUSES.has(currentStatus)) ||
        (currentCode && NETWORK_ERROR_CODES.has(currentCode)) ||
        (currentMessage && NETWORK_ERROR_SUBSTRINGS.some(sub => currentMessage.includes(sub)))
      ) {
        isNetwork = true
      }
    }

    // 4. Server
    if (!isServerError) {
      if (
        (currentName && SERVER_ERROR_NAMES.has(currentName)) ||
        (currentStatus !== undefined && currentStatus >= 500 && currentStatus <= 599) ||
        (currentCode && SERVER_ERROR_CODES.has(currentCode)) ||
        (currentMessage && SERVER_ERROR_SUBSTRINGS.some(sub => currentMessage.includes(sub)))
      ) {
        isServerError = true
      }
    }

    // 5. Transient Vault
    if (!isTransientVault) {
      if (
        currentName === 'VaultNotInitializedError' ||
        (currentMessage && TRANSIENT_VAULT_ERROR_SUBSTRINGS.some(sub => currentMessage.includes(sub)))
      ) {
        isTransientVault = true
      }
    }

    // 6. Missing Key (matched by name, like VaultNotInitializedError, because the classes live in code that imports this module)
    if (!isMissingKey) {
      if (currentName === 'MissingKeyError') {
        isMissingKey = true
      }
    }
    if (!missingKver && current.kver) {
      missingKver = current.kver
    }

    current = current.cause
    depth += 1
  }

  return {
    isAbort,
    isAuth,
    isNetwork,
    isServerError,
    isTransientVault,
    isMissingKey,
    status,
    message,
    ...(missingKver !== undefined ? { kver: missingKver } : {}),
  }
}

export function isAuthError(error: unknown): boolean {
  return classifySyncError(error).isAuth
}
