import localforage from 'localforage'

export const OFFLINE_QUEUE_SYNC_TAG = 'sync-vault'

export type QueuedMutation = {
  id: string
  mutationType: string
  payload: unknown
  session: string
  endpoint: string
  conflict?: boolean
  lastConflictAt?: number
  lastErrorStatus?: number
}

const syncQueue = localforage.createInstance({ name: 'FlockOfflineQueue' })
const QUEUE_KEY = 'mutations'

export async function readQueue(): Promise<QueuedMutation[]> {
  return (await syncQueue.getItem<QueuedMutation[]>(QUEUE_KEY)) || []
}

export async function writeQueue(queue: QueuedMutation[]) {
  await syncQueue.setItem(QUEUE_KEY, queue)
}

export function getMutationId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}
