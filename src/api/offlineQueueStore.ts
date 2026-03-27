import { syncDB } from './db'
import { Item } from '../state/items'

export const OFFLINE_QUEUE_SYNC_TAG = 'sync-vault'
export const OFFLINE_QUEUE_KEY = 'mutations'
export const ACTIVE_SESSION_TOKEN_KEY = 'active_session_token'
export const DEAD_LETTER_QUEUE_KEY = 'dead-letter-mutations'

export type QueuedMutation = {
  id: string
  mutationType: string
  payload: unknown
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
}

export async function readQueue(): Promise<QueuedMutation[]> {
  return (await syncDB.getItem<QueuedMutation[]>(OFFLINE_QUEUE_KEY)) || []
}

export async function writeQueue(queue: QueuedMutation[]) {
  await syncDB.setItem(OFFLINE_QUEUE_KEY, queue)
}

export async function readDeadLetterQueue(): Promise<QueuedMutation[]> {
  return (await syncDB.getItem<QueuedMutation[]>(DEAD_LETTER_QUEUE_KEY)) || []
}

export async function writeDeadLetterQueue(queue: QueuedMutation[]) {
  await syncDB.setItem(DEAD_LETTER_QUEUE_KEY, queue)
}

export async function moveToDeadLetterQueue(id: string, errorReason: string, status?: number): Promise<void> {
  const queue = await readQueue()
  const target = queue.find(item => item.id === id)
  if (!target) {
    return
  }

  const nextQueue = queue.filter(item => item.id !== id)
  const deadLetterQueue = await readDeadLetterQueue()
  deadLetterQueue.push({
    ...target,
    failedAt: Date.now(),
    errorReason,
    lastErrorStatus: status,
  })

  await Promise.all([
    writeQueue(nextQueue),
    writeDeadLetterQueue(deadLetterQueue),
  ])
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
  await syncDB.removeItem(OFFLINE_QUEUE_KEY)
}

export function getMutationId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}
