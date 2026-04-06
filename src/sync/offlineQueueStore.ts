import { syncDB } from '../api/db'
import { Item } from '../state/items'
import type { z } from 'zod'
import { DlqFailureSnapshotSchema } from '../shared/syncSchemas'
import localforage from 'localforage'

export const OFFLINE_QUEUE_SYNC_TAG = 'sync-vault'
export const OFFLINE_QUEUE_KEY = 'mutations'
export const ACTIVE_SESSION_TOKEN_KEY = 'active_session_token'
export const DEAD_LETTER_QUEUE_KEY = 'dead-letter-mutations'
const OFFLINE_QUEUE_TARGET_INDEX_STORE = 'offline-queue-target-index'
const OFFLINE_QUEUE_REVERSE_TARGET_INDEX_STORE = 'offline-queue-target-index-reverse'

export type DlqFailureSnapshot = z.infer<typeof DlqFailureSnapshotSchema>

export type QueuedMutation = {
  id: string
  mutationType: string
  humanTitle?: string
  payload: unknown
  conflictHandlerKey?: string
  endpoint: string
  queuedAt?: number
  baseState?: Item
  attemptCount?: number
  nextAttemptAt?: number
  conflict?: boolean
  lastConflictAt?: number
  lastErrorStatus?: number
  failedAt?: number
  errorReason?: string
  failureSnapshot?: DlqFailureSnapshot
}

const offlineQueueStorage = localforage.createInstance({
  name: 'FlockVaultDB',
  storeName: OFFLINE_QUEUE_KEY,
})

const deadLetterQueueStorage = localforage.createInstance({
  name: 'FlockVaultDB',
  storeName: DEAD_LETTER_QUEUE_KEY,
})

const queueTargetIndexStorage = localforage.createInstance({
  name: 'FlockVaultDB',
  storeName: OFFLINE_QUEUE_TARGET_INDEX_STORE,
})

const queueReverseTargetIndexStorage = localforage.createInstance({
  name: 'FlockVaultDB',
  storeName: OFFLINE_QUEUE_REVERSE_TARGET_INDEX_STORE,
})

type LocalForageInstance = ReturnType<typeof localforage.createInstance>

function sortQueuedMutations(left: QueuedMutation, right: QueuedMutation): number {
  const leftQueuedAt = left.queuedAt || 0
  const rightQueuedAt = right.queuedAt || 0
  if (leftQueuedAt !== rightQueuedAt) {
    return leftQueuedAt - rightQueuedAt
  }

  return left.id.localeCompare(right.id)
}

async function readAllFromStore(
  storage: LocalForageInstance,
): Promise<QueuedMutation[]> {
  const items: QueuedMutation[] = []
  await storage.iterate<QueuedMutation, void>(value => {
    if (value && typeof value === 'object' && typeof value.id === 'string') {
      items.push(value)
    }
  })

  items.sort(sortQueuedMutations)
  return items
}

export async function readQueue(): Promise<QueuedMutation[]> {
  return readAllFromStore(offlineQueueStorage)
}

export async function writeQueue(queue: QueuedMutation[]) {
  await offlineQueueStorage.clear()
  await queueTargetIndexStorage.clear()
  await queueReverseTargetIndexStorage.clear()

  await Promise.all(queue.map(async mutation => {
    await offlineQueueStorage.setItem(mutation.id, mutation)
  }))
}

export async function readDeadLetterQueue(): Promise<QueuedMutation[]> {
  return readAllFromStore(deadLetterQueueStorage)
}

export async function writeDeadLetterQueue(queue: QueuedMutation[]) {
  await deadLetterQueueStorage.clear()
  await Promise.all(queue.map(async mutation => {
    await deadLetterQueueStorage.setItem(mutation.id, mutation)
  }))
}

export async function readQueueLength(): Promise<number> {
  return offlineQueueStorage.length()
}

export async function readDeadLetterQueueLength(): Promise<number> {
  return deadLetterQueueStorage.length()
}

export async function getQueueMutationById(id: string): Promise<QueuedMutation | null> {
  return (await offlineQueueStorage.getItem<QueuedMutation>(id)) || null
}

export async function upsertQueueMutation(mutation: QueuedMutation): Promise<void> {
  await offlineQueueStorage.setItem(mutation.id, mutation)
}

export async function deleteQueueMutationById(id: string): Promise<void> {
  const targetKey = await queueReverseTargetIndexStorage.getItem<string>(id)
  await Promise.all([
    offlineQueueStorage.removeItem(id),
    queueReverseTargetIndexStorage.removeItem(id),
    targetKey ? queueTargetIndexStorage.removeItem(targetKey) : Promise.resolve(),
  ])
}

export async function appendDeadLetterMutation(mutation: QueuedMutation): Promise<void> {
  await deadLetterQueueStorage.setItem(mutation.id, mutation)
}

export async function setQueueTargetIndex(targetKey: string, mutationId: string): Promise<void> {
  await Promise.all([
    queueTargetIndexStorage.setItem(targetKey, mutationId),
    queueReverseTargetIndexStorage.setItem(mutationId, targetKey),
  ])
}

export async function clearQueueTargetIndex(targetKey: string): Promise<void> {
  const mutationId = await queueTargetIndexStorage.getItem<string>(targetKey)
  await Promise.all([
    queueTargetIndexStorage.removeItem(targetKey),
    mutationId ? queueReverseTargetIndexStorage.removeItem(mutationId) : Promise.resolve(),
  ])
}

export async function getQueueMutationIdByTargetIndex(targetKey: string): Promise<string | null> {
  return (await queueTargetIndexStorage.getItem<string>(targetKey)) || null
}

export async function moveToDeadLetterQueue(
  id: string,
  errorReason: string,
  status?: number,
  snapshot?: DlqFailureSnapshot,
  humanTitle?: string,
): Promise<void> {
  const target = await getQueueMutationById(id)
  if (!target) {
    return
  }

  await deleteQueueMutationById(id)
  await appendDeadLetterMutation({
    ...target,
    humanTitle,
    failedAt: Date.now(),
    errorReason,
    lastErrorStatus: status,
    failureSnapshot: snapshot,
  })
}

export async function getActiveSessionToken(): Promise<string | null> {
  return (await syncDB.getItem<string>(ACTIVE_SESSION_TOKEN_KEY)) || null
}

export async function setActiveSessionToken(sessionToken: string): Promise<void> {
  await syncDB.setItem(ACTIVE_SESSION_TOKEN_KEY, sessionToken)
}

export async function clearActiveSessionToken(): Promise<void> {
  await syncDB.removeItem(ACTIVE_SESSION_TOKEN_KEY)
}

export async function clearOfflineQueue(): Promise<void> {
  await Promise.all([
    offlineQueueStorage.clear(),
    queueTargetIndexStorage.clear(),
    queueReverseTargetIndexStorage.clear(),
  ])
}

export function getMutationId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}
