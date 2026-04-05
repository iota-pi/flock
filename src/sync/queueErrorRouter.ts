import { normalizeSyncError, getErrorReason, getErrorStatusCode, isStaleCompactedBranchError, isVersionConflictError } from '../shared/syncErrors'
import { emitSyncEvent } from './syncEvents'
import {
  getPayloadTelemetry,
  moveClientErrorMutationToDlq,
  moveUnhandledMutationToDlq,
} from './dlqManager'
import type { QueuedMutation } from './offlineQueueStore'

export function isLikelyNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  const message = error.message.toLowerCase()
  return (
    message.includes('failed to fetch')
    || message.includes('networkerror')
    || message.includes('fetch failed')
    || message.includes('network request failed')
    || message.includes('timeout')
    || message.includes('offline')
  )
}

export type QueueErrorDirective =
  | {
    type: 'retry-with-mutation'
    mutation: QueuedMutation
  }
  | {
    type: 'retry-later'
    mutation: QueuedMutation
  }
  | {
    type: 'routed-to-dlq'
    status?: number
    reason: string
  }
  | {
    type: 'skip'
  }

type QueueErrorRouterOptions = {
  mutation: QueuedMutation
  queueLength: number
  error: unknown
  resolveStaleCompactedBranch?: (mutation: QueuedMutation) => Promise<QueuedMutation | null>
  resolveVersionConflict?: (mutation: QueuedMutation) => Promise<QueuedMutation | null>
}

function getTelemetry(mutation: QueuedMutation, queueLength: number) {
  return {
    timestamp: Date.now(),
    queueLength,
    attemptCount: mutation.attemptCount,
    queuedAt: mutation.queuedAt,
    payloadSummary: getPayloadTelemetry(mutation.payload),
  }
}

export async function routeQueueMutationError(options: QueueErrorRouterOptions): Promise<QueueErrorDirective> {
  const mutation = {
    ...options.mutation,
    attemptCount: options.mutation.attemptCount || 0,
  }
  const normalizedError = normalizeSyncError(options.error)

  if (isStaleCompactedBranchError(normalizedError)) {
    const rescued = options.resolveStaleCompactedBranch
      ? await options.resolveStaleCompactedBranch(mutation)
      : null
    if (rescued) {
      return {
        type: 'retry-with-mutation',
        mutation: rescued,
      }
    }
  }

  if (isVersionConflictError(normalizedError)) {
    const resolved = options.resolveVersionConflict
      ? await options.resolveVersionConflict(mutation)
      : null
    if (resolved) {
      return {
        type: 'retry-with-mutation',
        mutation: resolved,
      }
    }
  }

  const status = getErrorStatusCode(normalizedError)
  const reason = getErrorReason(normalizedError)

  if (typeof status === 'number' && status >= 400 && status < 500 && status !== 429) {
    const dlqCount = await moveClientErrorMutationToDlq({
      mutation,
      errorReason: reason,
      status,
      telemetry: getTelemetry(mutation, options.queueLength),
    })

    emitSyncEvent({
      type: 'queue:dlq-count-changed',
      count: dlqCount,
    })

    emitSyncEvent({
      type: 'queue:mutation-failed',
      mutation,
      status,
      reason,
      routedToDlq: true,
    })

    if (mutation.baseState) {
      const targetId = mutation.baseState.id
      emitSyncEvent({
        type: 'queue:rollback-base-state',
        mutation,
        targetId,
        baseState: mutation.baseState,
      })
    }

    return {
      type: 'routed-to-dlq',
      status,
      reason,
    }
  }

  if (isLikelyNetworkError(normalizedError)) {
    const attemptCount = (mutation.attemptCount || 0) + 1
    const backoffDelay = 2000 * (2 ** attemptCount)

    return {
      type: 'retry-later',
      mutation: {
        ...mutation,
        attemptCount,
        nextAttemptAt: Date.now() + backoffDelay,
      },
    }
  }

  const dlqCount = await moveUnhandledMutationToDlq({
    mutation,
    status: status || 500,
    errorReason: reason,
    telemetry: getTelemetry(mutation, options.queueLength),
  })

  emitSyncEvent({
    type: 'queue:dlq-count-changed',
    count: dlqCount,
  })

  emitSyncEvent({
    type: 'queue:mutation-failed',
    mutation,
    status,
    reason,
    routedToDlq: true,
  })

  if (mutation.baseState) {
    const targetId = mutation.baseState.id
    emitSyncEvent({
      type: 'queue:rollback-base-state',
      mutation,
      targetId,
      baseState: mutation.baseState,
    })
  }

  return {
    type: 'routed-to-dlq',
    status,
    reason,
  }
}