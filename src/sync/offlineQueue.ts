import env from '../env'
import {
  clearQueueTargetIndex,
  deleteQueueMutationById,
  getQueueMutationById,
  getQueueMutationIdByTargetIndex,
  getMutationId,
  OFFLINE_QUEUE_SYNC_TAG,
  type QueuedMutation,
  readDeadLetterQueueLength,
  readQueue,
  readQueueLength,
  setQueueTargetIndex,
  upsertQueueMutation,
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
import { emitSyncEvent } from './syncEvents'
import { routeQueueMutationError } from './queueErrorRouter'
import { canProcessOfflineQueue, requestQueueProcessing } from './queueLeaderLock'
import { ensureDefaultMutationStrategiesRegistered } from './defaultMutationStrategies'
import {
  getQueueNetworkExecutor,
  initializeQueueNetworkExecutor,
  isQueueNetworkExecutorInitialized,
} from './queueNetworkExecutor'
import { createTrpcQueueNetworkExecutor } from './trpcQueueNetworkExecutor'

export { CONFLICT_HANDLER_AUTOMERGE_ITEMS } from './conflictStrategies'

let processing = false
const QUEUE_HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000

let queueHealthTimer: ReturnType<typeof setInterval> | null = null
let lastHighVolumeSignalAt = 0
let lastStaleSignalAt = 0
let strategiesInitialized = false

function ensureMutationStrategiesInitialized(): void {
  if (strategiesInitialized) {
    return
  }

  if (!isQueueNetworkExecutorInitialized()) {
    initializeQueueNetworkExecutor(createTrpcQueueNetworkExecutor())
  }

  ensureDefaultMutationStrategiesRegistered(getQueueNetworkExecutor())
  strategiesInitialized = true
}

function getMutationTargetKey(mutationType: string, payload: unknown): string | null {
  const targetIds = extractTargetIds(payload)
  if (targetIds.length === 0) {
    return null
  }

  return `${mutationType}:${targetIds.join('|')}`
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
  ensureMutationStrategiesInitialized()

  if (!env.VAULT_ENDPOINT) {
    throw new Error('Cannot queue offline mutation without API endpoint')
  }

  const mutationTargetKey = getMutationTargetKey(mutationType, payload)
  let existingMutation: QueuedMutation | null = null

  if (mutationTargetKey) {
    const existingMutationId = await getQueueMutationIdByTargetIndex(mutationTargetKey)
    if (existingMutationId) {
      existingMutation = await getQueueMutationById(existingMutationId)
    }
  }

  if (!existingMutation) {
    const queue = await readQueue()
    existingMutation = queue.find(mutation => hasMatchingMutationTarget(mutation, mutationType, payload)) || null
  }

  const nextMutation: QueuedMutation = {
    ...(existingMutation || {}),
    id: getMutationId(),
    mutationType,
    payload,
    endpoint: env.VAULT_ENDPOINT,
    queuedAt: Date.now(),
    baseState: metadata?.baseState || existingMutation?.baseState,
    conflictHandlerKey: metadata?.conflictHandlerKey || existingMutation?.conflictHandlerKey,
    attemptCount: existingMutation ? undefined : 0,
    nextAttemptAt: undefined,
    conflict: false,
    lastConflictAt: undefined,
    lastErrorStatus: undefined,
  }

  if (existingMutation && existingMutation.id !== nextMutation.id) {
    await deleteQueueMutationById(existingMutation.id)
  }

  await upsertQueueMutation(nextMutation)
  if (mutationTargetKey) {
    await setQueueTargetIndex(mutationTargetKey, nextMutation.id)
  }

  emitSyncEvent({ type: 'queue:length-changed', length: await readQueueLength() })
  requestQueueProcessing()

  await registerBackgroundSync()
}

export async function initialiseDeadLetterQueueCount() {
  emitSyncEvent({ type: 'queue:dlq-count-changed', count: await readDeadLetterQueueLength() })
  emitSyncEvent({ type: 'queue:length-changed', length: await readQueueLength() })
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
  ensureMutationStrategiesInitialized()

  if (!canProcessOfflineQueue()) {
    requestQueueProcessing()
    return
  }

  if (processing) {
    return
  }

  processing = true
  try {
    emitSyncEvent({ type: 'queue:processing-changed', isSyncing: true })
    const queue = await readQueue()
    emitSyncEvent({ type: 'queue:length-changed', length: queue.length })
    if (queue.length === 0) {
      return
    }

    for (let index = 0; index < queue.length; index += 1) {
      const mutation = queue[index]
      if (mutation.nextAttemptAt && mutation.nextAttemptAt > Date.now()) {
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
        await deleteQueueMutationById(normalizedMutation.id)
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
          if (directive.mutation.id !== normalizedMutation.id) {
            await deleteQueueMutationById(normalizedMutation.id)
          }

          await upsertQueueMutation(directive.mutation)
          const targetKey = getMutationTargetKey(directive.mutation.mutationType, directive.mutation.payload)
          if (targetKey) {
            await setQueueTargetIndex(targetKey, directive.mutation.id)
          }

          break
        }

        const targetKey = getMutationTargetKey(normalizedMutation.mutationType, normalizedMutation.payload)
        if (targetKey) {
          await clearQueueTargetIndex(targetKey)
        }
      }
    }

    emitSyncEvent({ type: 'queue:length-changed', length: await readQueueLength() })
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
