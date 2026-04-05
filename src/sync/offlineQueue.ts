import env from '../env'
import * as Sentry from '@sentry/react'
import { trpcClient } from '../api/trpcClient'
import { Item } from '../state/items'
import { queryClient } from '../api/queryClient'
import {
  emitSyncRuntimeMessage,
  setSyncRuntimeState,
} from './syncRuntime'
import {
  getErrorReason,
  getErrorStatusCode,
  isStaleCompactedBranchError,
  isVersionConflictError,
} from '../shared/syncErrors'
import {
  getMutationId,
  OFFLINE_QUEUE_SYNC_TAG,
  type QueuedMutation,
  readDeadLetterQueue,
  readQueue,
  writeQueue,
} from './offlineQueueStore'
import {
  getConflictStrategiesByKey,
  type QueueConflictHandler,
} from './conflictStrategies'
import {
  extractTargetIds,
  getPayloadTelemetry,
  moveClientErrorMutationToDlq,
  moveUnhandledMutationToDlq,
} from './dlqManager'
import { getQueryKey } from '@trpc/react-query'
import { trpc } from '../api/trpc'

export { CONFLICT_HANDLER_AUTOMERGE_ITEMS } from './conflictStrategies'

let processing = false
const CHUNK_SIZE = 50
const QUEUE_HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000

let queueHealthTimer: ReturnType<typeof setInterval> | null = null
let lastHighVolumeSignalAt = 0
let lastStaleSignalAt = 0

function invalidateItemsProjection() {
  void queryClient.invalidateQueries({ queryKey: getQueryKey(trpc.items.fetchMany) })
}

function hasMatchingMutationTarget(existing: QueuedMutation, mutationType: string, payload: unknown): boolean {
  if (existing.mutationType !== mutationType) {
    return false
  }

  const existingTargets = extractTargetIds(existing.payload)
  const incomingTargets = extractTargetIds(payload)
  if (existingTargets.length === 0 || incomingTargets.length === 0) {
    return false
  }

  if (existingTargets.length !== incomingTargets.length) {
    return false
  }

  return existingTargets.every((target, index) => target === incomingTargets[index])
}

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

type MutationExecutionStrategy = QueueConflictHandler & {
  execute: (mutation: QueuedMutation) => Promise<void>
}
const conflictStrategiesByKey = getConflictStrategiesByKey()

const mutationStrategies: Record<string, MutationExecutionStrategy> = {
  'items.put': {
    execute: async mutation => {
      const payload = mutation.payload as Parameters<typeof trpcClient.items.put.mutate>[0]
      await trpcClient.items.put.mutate({
        ...payload,
        idempotencyKey: mutation.id,
      })
    },
  },
  'items.putMany': {
    execute: async mutation => {
      const payload = mutation.payload as Parameters<typeof trpcClient.items.putMany.mutate>[0]
      const payloadItems = payload.items || []

      if (payloadItems.length <= CHUNK_SIZE) {
        await trpcClient.items.putMany.mutate({
          ...payload,
          idempotencyKey: mutation.id,
        })
        return
      }

      for (let index = 0; index < payloadItems.length; index += CHUNK_SIZE) {
        const chunk = payloadItems.slice(index, index + CHUNK_SIZE)
        await trpcClient.items.putMany.mutate({
          ...payload,
          items: chunk,
          idempotencyKey: mutation.id,
        })
      }
    },
  },
  'items.resolveBranchConflict': {
    execute: async mutation => {
      const payload = mutation.payload as Parameters<typeof trpcClient.items.resolveBranchConflict.mutate>[0]
      await trpcClient.items.resolveBranchConflict.mutate({
        ...payload,
        idempotencyKey: mutation.id,
      })
    },
  },
  'accounts.updateMetadata': {
    execute: async mutation => {
      await trpcClient.accounts.updateMetadata.mutate(
        mutation.payload as Parameters<typeof trpcClient.accounts.updateMetadata.mutate>[0],
      )
    },
  },
}

function getMutationStrategy(mutation: QueuedMutation): MutationExecutionStrategy {
  const base = mutationStrategies[mutation.mutationType]
  if (!base) {
    throw new Error(`Unknown offline mutation type: ${mutation.mutationType}`)
  }

  const conflictStrategy = mutation.conflictHandlerKey
    ? conflictStrategiesByKey[mutation.conflictHandlerKey]
    : undefined

  return {
    ...base,
    ...conflictStrategy,
  }
}

export async function enqueueMutation(
  mutationType: string,
  payload: unknown,
  metadata?: Pick<QueuedMutation, 'baseState' | 'conflictHandlerKey'>,
) {
  if (!env.VAULT_ENDPOINT) {
    throw new Error('Cannot queue offline mutation without API endpoint')
  }

  const queue = await readQueue()
  const existingIndex = queue.findIndex(mutation => hasMatchingMutationTarget(mutation, mutationType, payload))

  if (existingIndex >= 0) {
    queue[existingIndex] = {
      ...queue[existingIndex],
      id: getMutationId(),
      payload,
      endpoint: env.VAULT_ENDPOINT,
      queuedAt: Date.now(),
      baseState: metadata?.baseState || queue[existingIndex].baseState,
      conflictHandlerKey: metadata?.conflictHandlerKey || queue[existingIndex].conflictHandlerKey,
      attemptCount: undefined,
      nextAttemptAt: undefined,
    }
  } else {
    queue.push({
      id: getMutationId(),
      mutationType,
      payload,
      endpoint: env.VAULT_ENDPOINT,
      queuedAt: Date.now(),
      baseState: metadata?.baseState,
      conflictHandlerKey: metadata?.conflictHandlerKey,
      attemptCount: 0,
      nextAttemptAt: undefined,
      conflict: false,
    })
  }

  await writeQueue(queue)
  setSyncRuntimeState({ offlineQueueLength: queue.length })
  invalidateItemsProjection()

  await registerBackgroundSync()
}

export async function initialiseDeadLetterQueueCount() {
  const deadLetterQueue = await readDeadLetterQueue()
  const queue = await readQueue()
  setSyncRuntimeState({
    dlqCount: deadLetterQueue.length,
    offlineQueueLength: queue.length,
  })
}

export async function registerBackgroundSync() {
  if (
    typeof navigator === 'undefined'
    || typeof window === 'undefined'
    || !('serviceWorker' in navigator)
    || !('SyncManager' in window)
  ) {
    return
  }

  const swRegistration = await navigator.serviceWorker.ready
  await (swRegistration as ServiceWorkerRegistration & {
    sync: { register: (tag: string) => Promise<void> }
  }).sync.register(OFFLINE_QUEUE_SYNC_TAG)
}

export async function processOfflineQueue() {
  if (processing) {
    return
  }

  processing = true
  try {
    setSyncRuntimeState({ isSyncing: true })
    const queue = await readQueue()
    setSyncRuntimeState({ offlineQueueLength: queue.length })
    if (queue.length === 0) {
      return
    }

    const nextQueue: QueuedMutation[] = []

    for (let index = 0; index < queue.length; index += 1) {
      const mutation = queue[index]
      if (mutation.nextAttemptAt && mutation.nextAttemptAt > Date.now()) {
        nextQueue.push(mutation)
        continue
      }

      const normalizedMutation = {
        ...mutation,
        attemptCount: mutation.attemptCount,
        nextAttemptAt: undefined,
        conflict: false,
        lastConflictAt: undefined,
        lastErrorStatus: undefined,
      }

      const strategy = getMutationStrategy(normalizedMutation)

      try {
        await strategy.execute(normalizedMutation)
        if (normalizedMutation.mutationType === 'items.put' || normalizedMutation.mutationType === 'items.putMany') {
          invalidateItemsProjection()
        }
      } catch (error) {
        if (isStaleCompactedBranchError(error)) {
          const rescued = strategy.resolveStaleCompactedBranch
            ? await strategy.resolveStaleCompactedBranch(normalizedMutation)
            : null
          if (rescued) {
            nextQueue.push(rescued, ...queue.slice(index + 1))
            break
          }
        }

        if (isVersionConflictError(error)) {
          const resolved = strategy.resolveVersionConflict
            ? await strategy.resolveVersionConflict(normalizedMutation)
            : null
          if (resolved) {
            nextQueue.push(resolved, ...queue.slice(index + 1))
            break
          }
        }

        const status = getErrorStatusCode(error)
        if (typeof status === 'number' && status >= 400 && status < 500 && status !== 429) {
          const dlqCount = await moveClientErrorMutationToDlq({
            mutation: normalizedMutation,
            errorReason: getErrorReason(error),
            status,
            telemetry: {
              timestamp: Date.now(),
              queueLength: queue.length,
              attemptCount: normalizedMutation.attemptCount,
              queuedAt: normalizedMutation.queuedAt,
              payloadSummary: getPayloadTelemetry(normalizedMutation.payload),
            },
          })
          setSyncRuntimeState({ dlqCount })
          emitSyncRuntimeMessage({
            severity: 'warning',
            message: 'An invalid offline change was isolated for recovery and sync continued.',
          })
          continue
        }

        if (isLikelyNetworkError(error)) {
          const attemptCount = (mutation.attemptCount || 0) + 1
          const backoffDelay = 2000 * Math.pow(2, attemptCount)

          nextQueue.push({
            ...normalizedMutation,
            attemptCount,
            nextAttemptAt: Date.now() + backoffDelay,
          }, ...queue.slice(index + 1))
          break
        }

        const dlqCount = await moveUnhandledMutationToDlq({
          mutation: normalizedMutation,
          status: status || 500,
          errorReason: error instanceof Error ? error.message : 'Unhandled sync error',
          telemetry: {
            timestamp: Date.now(),
            queueLength: queue.length,
            attemptCount: normalizedMutation.attemptCount,
            queuedAt: normalizedMutation.queuedAt,
            payloadSummary: getPayloadTelemetry(normalizedMutation.payload),
          },
        })
        Sentry.captureException(error, {
          tags: {
            queueAction: 'dlq_routing',
            mutationType: normalizedMutation.mutationType,
          },
          extra: {
            mutationId: normalizedMutation.id,
            payload: getPayloadTelemetry(normalizedMutation.payload),
          },
        })
        setSyncRuntimeState({ dlqCount })

        if (normalizedMutation.baseState) {
          const targetIds = extractTargetIds(normalizedMutation.payload)
          const targetId = targetIds[0] || normalizedMutation.baseState.id

          queryClient.setQueryData<Item[]>(getQueryKey(trpc.items.fetchMany), previous => {
            if (!previous) {
              return [normalizedMutation.baseState as Item]
            }

            const index = previous.findIndex(item => item.id === targetId)
            if (index === -1) {
              return [...previous, normalizedMutation.baseState as Item]
            }

            const next = [...previous]
            next[index] = normalizedMutation.baseState as Item
            return next
          })
        }

        emitSyncRuntimeMessage({
          severity: 'error',
          message: 'An offline save failed and was moved to recovery queue. Please review recovery options.',
        })
      }
    }

    await writeQueue(nextQueue)
    setSyncRuntimeState({ offlineQueueLength: nextQueue.length })
    invalidateItemsProjection()
  } finally {
    setSyncRuntimeState({ isSyncing: false })
    processing = false
  }
}

export async function checkQueueHealth() {
  const queueItems = await readQueue()
  if (queueItems.length === 0) {
    return
  }

  const oldestQueuedAt = queueItems.reduce((oldest, item) => {
    const queuedAt = item.queuedAt || 0
    if (queuedAt <= 0) {
      return oldest
    }
    if (oldest <= 0) {
      return queuedAt
    }
    return Math.min(oldest, queuedAt)
  }, 0)

  const ageInMinutes = oldestQueuedAt > 0
    ? (Date.now() - oldestQueuedAt) / 1000 / 60
    : 0

  if (queueItems.length > 50 && Date.now() - lastHighVolumeSignalAt > 60 * 60 * 1000) {
    lastHighVolumeSignalAt = Date.now()
    Sentry.captureMessage('High Offline Queue Volume', {
      level: 'warning',
      extra: {
        queueLength: queueItems.length,
        oldestItemAgeMinutes: Math.round(ageInMinutes),
      },
    })
  }

  if (ageInMinutes > 1440 && Date.now() - lastStaleSignalAt > 60 * 60 * 1000) {
    lastStaleSignalAt = Date.now()
    Sentry.captureMessage('Stale Offline Queue Detected', {
      level: 'error',
      extra: {
        queueLength: queueItems.length,
        oldestItemAgeMinutes: Math.round(ageInMinutes),
      },
    })
  }
}

export function startOfflineQueueHealthMonitor() {
  if (queueHealthTimer || typeof window === 'undefined') {
    return
  }

  queueHealthTimer = setInterval(() => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return
    }
    void checkQueueHealth()
  }, QUEUE_HEALTH_CHECK_INTERVAL_MS)

  void checkQueueHealth()
}
