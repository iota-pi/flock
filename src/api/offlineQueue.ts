import env from '../env'
import * as Sentry from '@sentry/react'
import { isAxiosError } from 'axios'
import { trpcClient } from './trpcClient'
import { Item } from '../state/items'
import { mergeFromBaseWithAutomerge } from '../utils/automergeMerge'
import { queryClient, queryKeys } from './queryClient'
import { useUiStore } from '../state/uiStore'
import { decryptObject, encryptObject } from './Vault'
import { vaultFetchMany } from './VaultAPI'
import { decryptVaultItems } from './queries'
import {
  getMutationId,
  OFFLINE_QUEUE_SYNC_TAG,
  type QueuedMutation,
  moveToDeadLetterQueue,
  readDeadLetterQueue,
  readQueue,
  writeDeadLetterQueue,
  writeQueue,
} from './offlineQueueStore'

let processing = false
const CHUNK_SIZE = 50
const QUEUE_HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000

let queueHealthTimer: ReturnType<typeof setInterval> | null = null
let lastHighVolumeSignalAt = 0
let lastStaleSignalAt = 0

function extractTargetIds(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') {
    return []
  }

  const singleItem = payload as { item?: unknown }
  if (typeof singleItem.item === 'string') {
    return [singleItem.item]
  }

  const batch = payload as { items?: Array<{ id?: unknown }> }
  if (Array.isArray(batch.items)) {
    return batch.items
      .map(item => item?.id)
      .filter((id): id is string => typeof id === 'string')
      .sort()
  }

  return []
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

function getPayloadTelemetry(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object') {
    return {}
  }

  const typed = payload as {
    account?: unknown
    item?: unknown
    items?: Array<{ id?: unknown }>
  }

  const targetIds = extractTargetIds(payload)

  return {
    account: typeof typed.account === 'string' ? typed.account : undefined,
    item: typeof typed.item === 'string' ? typed.item : undefined,
    itemIds: targetIds,
    itemCount: Array.isArray(typed.items) ? typed.items.length : undefined,
  }
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

function getClientErrorStatus(error: unknown): number | undefined {
  if (isAxiosError(error) && typeof error.response?.status === 'number') {
    return error.response.status
  }

  const maybeTrpcError = error as { data?: { httpStatus?: unknown } }
  if (typeof maybeTrpcError?.data?.httpStatus === 'number') {
    return maybeTrpcError.data.httpStatus
  }

  return undefined
}

function getClientErrorReason(error: unknown): string {
  if (isAxiosError(error)) {
    const data = error.response?.data as { message?: unknown } | undefined
    if (typeof data?.message === 'string' && data.message.trim()) {
      return data.message
    }
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message
  }

  return 'Client error'
}

function isVersionConflictError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  const message = error.message.toLowerCase()
  return message.includes('version conflict') || message.includes('conditionalcheckfailed')
}

async function resolveQueuedPutConflict(mutation: QueuedMutation): Promise<QueuedMutation | null> {
  if (mutation.mutationType !== 'items.put') {
    return null
  }

  const payload = mutation.payload as {
    account?: string
    item?: string
    cipher?: string
    iv?: string
    modified?: number
    type?: Item['type']
    version?: number
    deleted?: boolean
  }

  if (!payload.item || !payload.cipher || !payload.iv || !payload.type) {
    return null
  }

  const decryptedLocal = await decryptObject({
    cipher: payload.cipher,
    iv: payload.iv,
  }) as Item

  const currentItems = (queryClient.getQueryData<Item[]>(queryKeys.items) || [])
  const fallbackBase = currentItems.find(item => item.id === payload.item)
  const base = mutation.baseState || fallbackBase || decryptedLocal

  const serverResult = await vaultFetchMany({ ids: [payload.item] })
  const serverItems = await decryptVaultItems(serverResult.items)
  const theirs = serverItems.find(item => item.id === payload.item)
  if (!theirs) {
    return null
  }

  const merged = await mergeFromBaseWithAutomerge(base, theirs, decryptedLocal)
  merged.version = (theirs.version || 0) + 1

  const encrypted = await encryptObject(merged)

  return {
    ...mutation,
    payload: {
      account: payload.account,
      item: payload.item,
      cipher: encrypted.cipher,
      iv: encrypted.iv,
      modified: Date.now(),
      type: payload.type,
      version: merged.version,
      deleted: payload.deleted,
    },
    conflict: true,
    lastConflictAt: Date.now(),
    attemptCount: (mutation.attemptCount || 0) + 1,
    nextAttemptAt: Date.now() + 500,
  }
}

export async function enqueueMutation(
  mutationType: string,
  payload: unknown,
  metadata?: Pick<QueuedMutation, 'baseState'>,
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
      attemptCount: 0,
      nextAttemptAt: undefined,
      conflict: false,
    })
  }

  await writeQueue(queue)
  useUiStore.getState().setOfflineQueueLength(queue.length)

  await registerBackgroundSync()
}

export async function initialiseDeadLetterQueueCount() {
  const deadLetterQueue = await readDeadLetterQueue()
  const queue = await readQueue()
  useUiStore.getState().setDlqCount(deadLetterQueue.length)
  useUiStore.getState().setOfflineQueueLength(queue.length)
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

async function executeMutation(mutation: QueuedMutation) {
  switch (mutation.mutationType) {
    case 'items.put': {
      const payload = mutation.payload as Parameters<typeof trpcClient.items.put.mutate>[0]
      await trpcClient.items.put.mutate({
        ...payload,
        idempotencyKey: mutation.id,
      })
      return
    }
    case 'items.putMany': {
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
      return
    }
    case 'accounts.updateMetadata':
      await trpcClient.accounts.updateMetadata.mutate(mutation.payload as Parameters<typeof trpcClient.accounts.updateMetadata.mutate>[0])
      return
    default:
      throw new Error(`Unknown offline mutation type: ${mutation.mutationType}`)
  }
}

export async function processOfflineQueue() {
  if (processing) {
    return
  }

  processing = true
  try {
    useUiStore.getState().setIsSyncing(true)
    const queue = await readQueue()
    useUiStore.getState().setOfflineQueueLength(queue.length)
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

      try {
        await executeMutation(normalizedMutation)
      } catch (error) {
        const status = getClientErrorStatus(error)
        if (typeof status === 'number' && status >= 400 && status < 500 && status !== 429) {
          await moveToDeadLetterQueue(normalizedMutation.id, getClientErrorReason(error), status)
          const deadLetterQueue = await readDeadLetterQueue()
          useUiStore.getState().setDlqCount(deadLetterQueue.length)
          useUiStore.getState().setMessage({
            severity: 'warning',
            message: 'An invalid offline change was isolated for recovery and sync continued.',
          })
          continue
        }

        if (isVersionConflictError(error)) {
          const resolved = await resolveQueuedPutConflict(normalizedMutation)
          if (resolved) {
            nextQueue.push(resolved, ...queue.slice(index + 1))
            break
          }
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

        const deadLetterQueue = await readDeadLetterQueue()
        deadLetterQueue.push({
          ...normalizedMutation,
          lastErrorStatus: status || 500,
          failedAt: Date.now(),
          errorReason: error instanceof Error ? error.message : 'Unhandled sync error',
        })
        await writeDeadLetterQueue(deadLetterQueue)
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
        useUiStore.getState().setDlqCount(deadLetterQueue.length)

        if (normalizedMutation.baseState) {
          const targetIds = extractTargetIds(normalizedMutation.payload)
          const targetId = targetIds[0] || normalizedMutation.baseState.id

          queryClient.setQueryData<Item[]>(queryKeys.items, previous => {
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

        useUiStore.getState().setMessage({
          severity: 'error',
          message: 'An offline save failed and was moved to recovery queue. Please review recovery options.',
        })
      }
    }

    await writeQueue(nextQueue)
    useUiStore.getState().setOfflineQueueLength(nextQueue.length)
  } finally {
    useUiStore.getState().setIsSyncing(false)
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
