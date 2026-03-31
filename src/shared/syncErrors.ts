import type { ItemId } from './itemTypes'

export class VersionConflictError extends Error {
  conflictIds: ItemId[]
  status?: number

  constructor(message = 'Version conflict', conflictIds: ItemId[] = [], status?: number) {
    super(message)
    this.name = 'VersionConflictError'
    this.conflictIds = conflictIds
    this.status = status
  }
}

export class StaleCompactedBranchError extends Error {
  constructor(message = 'STALE_COMPACTED_BRANCH') {
    super(message)
    this.name = 'StaleCompactedBranchError'
  }
}

export function hasVersionConflictSignature(text: string): boolean {
  const normalized = text.toLowerCase()
  return normalized.includes('version conflict') || normalized.includes('conditionalcheckfailed')
}

function extractErrorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  const maybeAny = error as {
    message?: unknown
    shape?: { message?: unknown }
    data?: { cause?: { message?: unknown } }
  }

  const values = [
    typeof maybeAny?.message === 'string' ? maybeAny.message : '',
    typeof maybeAny?.shape?.message === 'string' ? maybeAny.shape.message : '',
    typeof maybeAny?.data?.cause?.message === 'string' ? maybeAny.data.cause.message : '',
  ].filter(Boolean)

  return values.join(' | ')
}

export function isVersionConflictError(error: unknown): boolean {
  if (error instanceof VersionConflictError) {
    return true
  }

  return hasVersionConflictSignature(extractErrorText(error))
}

export function isStaleCompactedBranchError(error: unknown): boolean {
  if (error instanceof StaleCompactedBranchError) {
    return true
  }

  return extractErrorText(error).includes('STALE_COMPACTED_BRANCH')
}

export function getErrorStatusCode(error: unknown): number | undefined {
  const maybeTrpcError = error as { data?: { httpStatus?: unknown }, status?: unknown }
  if (typeof maybeTrpcError?.data?.httpStatus === 'number') {
    return maybeTrpcError.data.httpStatus
  }
  if (typeof maybeTrpcError?.status === 'number') {
    return maybeTrpcError.status
  }
  return undefined
}

export function getErrorReason(error: unknown): string {
  const text = extractErrorText(error).trim()
  return text || 'Client error'
}
