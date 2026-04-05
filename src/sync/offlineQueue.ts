import env from '../env'
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
} from './dlqManager'
import {
  getRegisteredMutationStrategy,
  type RegisteredMutationStrategy,
} from './mutationStrategyRegistry'
import { ensureDefaultMutationStrategiesRegistered } from './defaultMutationStrategies'
import { emitSyncEvent } from './syncEvents'
import { routeQueueMutationError } from './queueErrorRouter'
import { canProcessOfflineQueue, requestQueueProcessing } from './queueLeaderLock'

export { CONFLICT_HANDLER_AUTOMERGE_ITEMS } from './conflictStrategies'

let processing = false
const QUEUE_HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000

let queueHealthTimer: ReturnType<typeof setInterval> | null = null
let lastHighVolumeSignalAt = 0
let lastStaleSignalAt = 0

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

type MutationExecutionStrategy = QueueConflictHandler & RegisteredMutationStrategy
const conflictStrategiesByKey = getConflictStrategiesByKey()

function getMutationStrategy(mutation: QueuedMutation): MutationExecutionStrategy {
  const base = getRegisteredMutationStrategy(mutation.mutationType)
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
  emitSyncEvent({ type: 'queue:length-changed', length: queue.length })
  requestQueueProcessing()

  await registerBackgroundSync()
}

export async function initialiseDeadLetterQueueCount() {
  const deadLetterQueue = await readDeadLetterQueue()
  const queue = await readQueue()
  emitSyncEvent({ type: 'queue:dlq-count-changed', count: deadLetterQueue.length })
  emitSyncEvent({ type: 'queue:length-changed', length: queue.length })
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
  if (!canProcessOfflineQueue()) {
    requestQueueProcessing()
    return
  }

  if (processing) {
    return
  }

  processing = true
  try {
    ensureDefaultMutationStrategiesRegistered()
    emitSyncEvent({ type: 'queue:processing-changed', isSyncing: true })
    const queue = await readQueue()
    emitSyncEvent({ type: 'queue:length-changed', length: queue.length })
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
        emitSyncEvent({
          type: 'queue:mutation-success',
          mutation: normalizedMutation,
        })
      } catch (error) {
        const directive = await routeQueueMutationError({
          mutation: {
            ...normalizedMutation,
            baseState: normalizedMutation.baseState,
          },
          queueLength: queue.length,
          error,
          resolveStaleCompactedBranch: strategy.resolveStaleCompactedBranch,
          resolveVersionConflict: strategy.resolveVersionConflict,
        })

        if (directive.type === 'retry-with-mutation' || directive.type === 'retry-later') {
          nextQueue.push(directive.mutation, ...queue.slice(index + 1))
          break
        }
      }
    }

    await writeQueue(nextQueue)
    emitSyncEvent({ type: 'queue:length-changed', length: nextQueue.length })
  } finally {
    emitSyncEvent({ type: 'queue:processing-changed', isSyncing: false })
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
    emitSyncEvent({
      type: 'queue:health-warning',
      code: 'high-volume',
      queueLength: queueItems.length,
      oldestItemAgeMinutes: Math.round(ageInMinutes),
    })
  }

  if (ageInMinutes > 1440 && Date.now() - lastStaleSignalAt > 60 * 60 * 1000) {
    lastStaleSignalAt = Date.now()
    emitSyncEvent({
      type: 'queue:health-warning',
      code: 'stale',
      queueLength: queueItems.length,
      oldestItemAgeMinutes: Math.round(ageInMinutes),
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
