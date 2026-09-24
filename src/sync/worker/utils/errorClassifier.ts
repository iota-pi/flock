import { isAbortError } from './abort'
import { MissingKeyError } from './decryptWithKeyResolution'
import { parseError, type ParsedError } from './errorParser'

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

const AUTH_HTTP_STATUSES = new Set([401, 403])

const AUTH_ERROR_CODES = new Set(['UNAUTHORIZED', 'FORBIDDEN'])

const AUTH_ERROR_NAMES = new Set([
  'UnauthorizedError',
  'ForbiddenError',
  'AuthExpiredError',
  'AuthError',
])

/**
 * Classifies an unknown error into declarative boolean flags, status, and message.
 * Inspects parsed error data and its cause chain in a single pass.
 */
export function classifySyncError(error: unknown): ClassifiedError {
  const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false

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
  let isTransientVault = (error as { name?: unknown })?.name === 'VaultNotInitializedError'
  let isMissingKey = error instanceof MissingKeyError
  let missingKver: string | undefined =
    error instanceof MissingKeyError
      ? error.kver
      : typeof (error as { kver?: unknown })?.kver === 'string'
        ? (error as { kver: string }).kver
        : undefined

  let status = parsed.status
  const message =
    parsed.message ??
    (error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : typeof (error as { message?: unknown })?.message === 'string'
          ? (error as { message: string }).message
          : '')

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

    // 6. Missing Key
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

  // Handle direct string errors checking for transient vault
  if (!isTransientVault && typeof error === 'string') {
    const lower = error.toLowerCase()
    if (TRANSIENT_VAULT_ERROR_SUBSTRINGS.some(sub => lower.includes(sub))) {
      isTransientVault = true
    }
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

export class ErrorClassifier {
  static classify(error: unknown): ClassifiedError {
    return classifySyncError(error)
  }
}

export function isAuthError(error: unknown): boolean {
  return classifySyncError(error).isAuth
}

export function isNetworkError(error: unknown): boolean {
  return classifySyncError(error).isNetwork
}

export function isServerError(error: unknown): boolean {
  return classifySyncError(error).isServerError
}

export function isTransientVaultError(error: unknown): boolean {
  return classifySyncError(error).isTransientVault
}
