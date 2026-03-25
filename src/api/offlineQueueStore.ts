import localforage from 'localforage'

export const OFFLINE_QUEUE_SYNC_TAG = 'sync-vault'

export type QueuedMutation = {
  id: string
  mutationType: string
  payload: unknown
  endpoint: string
  conflict?: boolean
  lastConflictAt?: number
  lastErrorStatus?: number
}

const syncQueue = localforage.createInstance({ name: 'FlockOfflineQueue' })
const QUEUE_KEY = 'mutations'
const ACTIVE_SESSION_TOKEN_KEY = 'active_session_token'

export async function readQueue(): Promise<QueuedMutation[]> {
  return (await syncQueue.getItem<QueuedMutation[]>(QUEUE_KEY)) || []
}

export async function writeQueue(queue: QueuedMutation[]) {
  await syncQueue.setItem(QUEUE_KEY, queue)
}

export async function getActiveSessionToken(): Promise<string | null> {
  return (await syncQueue.getItem<string>(ACTIVE_SESSION_TOKEN_KEY)) || null
}

export async function setActiveSessionToken(sessionToken: string): Promise<void> {
  await syncQueue.setItem(ACTIVE_SESSION_TOKEN_KEY, sessionToken)
}

export async function clearActiveSessionToken(): Promise<void> {
  await syncQueue.removeItem(ACTIVE_SESSION_TOKEN_KEY)
}

export function getMutationId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}
