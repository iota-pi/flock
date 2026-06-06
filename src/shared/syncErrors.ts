import { ItemId } from './schemas/items'

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

class StaleCompactedBranchError extends Error {
  constructor(message = 'STALE_COMPACTED_BRANCH') {
    super(message)
    this.name = 'StaleCompactedBranchError'
  }
}

function hasVersionConflictSignature(text: string): boolean {
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

function isVersionConflictError(error: unknown): boolean {
  if (error instanceof VersionConflictError) {
    return true
  }

  return hasVersionConflictSignature(extractErrorText(error))
}

function isStaleCompactedBranchError(error: unknown): boolean {
  if (error instanceof StaleCompactedBranchError) {
    return true
  }

  return extractErrorText(error).includes('STALE_COMPACTED_BRANCH')
}

export function normalizeSyncError(error: unknown): Error {
  if (error instanceof Error) {
    if (error instanceof StaleCompactedBranchError) {
      return error
    }

    if (error instanceof VersionConflictError) {
      return error
    }

    if (isStaleCompactedBranchError(error)) {
      return new StaleCompactedBranchError()
    }

    if (isVersionConflictError(error)) {
      return new VersionConflictError(error.message || 'Version conflict')
    }

    return error
  }

  if (isStaleCompactedBranchError(error)) {
    return new StaleCompactedBranchError()
  }

  if (isVersionConflictError(error)) {
    return new VersionConflictError('Version conflict')
  }

  return new Error('Sync operation failed')
}
