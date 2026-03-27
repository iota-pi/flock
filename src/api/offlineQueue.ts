import env from '../env'
import * as Sentry from '@sentry/react'
import { trpcClient } from './trpcClient'
import { threeWayMerge } from '../utils/merge'
import { Item } from '../state/items'
import { queryClient, queryKeys } from './queryClient'
import { decryptVaultItems } from './queries'
import { vaultFetchMany, type VaultItem } from './VaultAPI'
import { useUiStore } from '../state/uiStore'
import { getAccountId } from './util'
import {
  getMutationId,
  OFFLINE_QUEUE_SYNC_TAG,
  type QueuedMutation,
  readDeadLetterQueue,
  readQueue,
  writeDeadLetterQueue,
  writeQueue,
} from './offlineQueueStore'

let processing = false
const CHUNK_SIZE = 50

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

function isVersionConflictError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  const message = error.message.toLowerCase()
  return message.includes('version conflict') || message.includes('conditionalcheckfailed')
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

async function getVaultModule() {
  return import('./Vault')
}

function updateCachedItem(mergedItem: Item) {
  queryClient.setQueryData<Item[]>(queryKeys.items, previous => {
    const current = previous || []
    const index = current.findIndex(item => item.id === mergedItem.id)
    if (index === -1) {
      return [...current, mergedItem]
    }

    const next = [...current]
    next[index] = mergedItem
    return next
  })
}

function getBaseItemFromCache(itemId: string): Item | undefined {
  const cached = queryClient.getQueryData<Item[]>(queryKeys.items) || []
  return cached.find(item => item.id === itemId)
}

async function resolveQueuedItemPutConflict(mutation: QueuedMutation): Promise<QueuedMutation | null> {
  if (mutation.mutationType !== 'items.put') {
    return null
  }

  const payload = mutation.payload as {
    account: string
    item: string
    cipher: string
    iv: string
    modified: number
    type: Item['type']
    version?: number
    deleted?: boolean
  }

  const localAccountId = getAccountId()
  if (payload.account !== localAccountId) {
    return mutation
  }

  const vault = await getVaultModule()
  const localDecrypted = await vault.decryptObject({
    cipher: payload.cipher,
    iv: payload.iv,
  }) as Item

  if (typeof payload.version === 'number') {
    localDecrypted.version = payload.version
  }
  if (payload.deleted) {
    localDecrypted.deleted = payload.deleted
  }

  const response = await vaultFetchMany({ ids: [payload.item] })
  const remoteItems = await decryptVaultItems(response.items as VaultItem[])
  const remoteItem = remoteItems[0] || localDecrypted
  const baseItem = getBaseItemFromCache(payload.item) || localDecrypted

  const mergedItem = threeWayMerge(baseItem, remoteItem, localDecrypted)
  const baseVersion = Math.max(
    baseItem.version || 0,
    remoteItem.version || 0,
    localDecrypted.version || 0,
  )
  mergedItem.version = baseVersion + 1

  updateCachedItem(mergedItem)

  const encrypted = await vault.encryptObject(mergedItem)
  return {
    ...mutation,
    conflict: true,
    lastConflictAt: Date.now(),
    payload: {
      account: payload.account,
      item: mergedItem.id,
      cipher: encrypted.cipher,
      iv: encrypted.iv,
      modified: Date.now(),
      type: mergedItem.type,
      version: mergedItem.version,
      deleted: mergedItem.deleted,
    },
  }
}

async function resolveQueuedPutManyConflict(mutation: QueuedMutation): Promise<QueuedMutation | null> {
  if (mutation.mutationType !== 'items.putMany') {
    return null
  }

  const payload = mutation.payload as {
    account: string
    items: Array<{
      id: string
      cipher: string
      iv: string
      modified: number
      type: Item['type']
      version?: number
      deleted?: boolean
    }>
  }

  const localAccountId = getAccountId()
  if (payload.account !== localAccountId) {
    return mutation
  }

  const vault = await getVaultModule()
  const localItems = await Promise.all(payload.items.map(async queuedItem => {
    const decrypted = await vault.decryptObject({
      cipher: queuedItem.cipher,
      iv: queuedItem.iv,
    }) as Item
    if (typeof queuedItem.version === 'number') {
      decrypted.version = queuedItem.version
    }
    if (queuedItem.deleted) {
      decrypted.deleted = queuedItem.deleted
    }
    return decrypted
  }))

  const ids = payload.items.map(item => item.id)
  const response = await vaultFetchMany({ ids })
  const remoteItems = await decryptVaultItems(response.items as VaultItem[])
  const remoteById = new Map(remoteItems.map(item => [item.id, item]))

  const mergedItems: Item[] = localItems.map(localItem => {
    const remoteItem = remoteById.get(localItem.id) || localItem
    const baseItem = getBaseItemFromCache(localItem.id) || localItem
    const mergedItem = threeWayMerge(baseItem, remoteItem, localItem)
    const baseVersion = Math.max(
      baseItem.version || 0,
      remoteItem.version || 0,
      localItem.version || 0,
    )
    mergedItem.version = baseVersion + 1
    updateCachedItem(mergedItem)
    return mergedItem
  })

  const encrypted = await Promise.all(mergedItems.map(item => vault.encryptObject(item)))
  return {
    ...mutation,
    conflict: true,
    lastConflictAt: Date.now(),
    payload: {
      account: payload.account,
      items: mergedItems.map((item, index) => ({
        id: item.id,
        cipher: encrypted[index].cipher,
        iv: encrypted[index].iv,
        modified: Date.now(),
        type: item.type,
        version: item.version,
        deleted: item.deleted,
      })),
    },
  }
}

async function resolveQueuedConflict(mutation: QueuedMutation): Promise<QueuedMutation | null> {
  if (mutation.mutationType === 'items.put') {
    return resolveQueuedItemPutConflict(mutation)
  }

  if (mutation.mutationType === 'items.putMany') {
    return resolveQueuedPutManyConflict(mutation)
  }

  return null
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

        if (isVersionConflictError(error)) {
          const mergedMutation = await resolveQueuedConflict(normalizedMutation)
          if (mergedMutation) {
            nextQueue.push(mergedMutation, ...queue.slice(index + 1))
            break
          }

          nextQueue.push({
            ...normalizedMutation,
            conflict: true,
            lastConflictAt: Date.now(),
          }, ...queue.slice(index + 1))
          break
        }

        const deadLetterQueue = await readDeadLetterQueue()
        deadLetterQueue.push({
          ...normalizedMutation,
          lastErrorStatus: 500,
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
