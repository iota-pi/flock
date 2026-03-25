import localforage from 'localforage'
import { trpcClient } from './trpcClient'

const syncQueue = localforage.createInstance({ name: 'FlockOfflineQueue' })
const QUEUE_KEY = 'mutations'

type QueuedMutation = {
  id: string
  mutationType: string
  payload: unknown
}

let processing = false

function getMutationId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
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

async function readQueue(): Promise<QueuedMutation[]> {
  return (await syncQueue.getItem<QueuedMutation[]>(QUEUE_KEY)) || []
}

async function writeQueue(queue: QueuedMutation[]) {
  await syncQueue.setItem(QUEUE_KEY, queue)
}

export async function enqueueMutation(mutationType: string, payload: unknown) {
  const queue = await readQueue()
  queue.push({
    id: getMutationId(),
    mutationType,
    payload,
  })
  await writeQueue(queue)
}

async function executeMutation(mutation: QueuedMutation) {
  switch (mutation.mutationType) {
    case 'items.put':
      await trpcClient.items.put.mutate(mutation.payload as Parameters<typeof trpcClient.items.put.mutate>[0])
      return
    case 'items.putMany':
      await trpcClient.items.putMany.mutate(mutation.payload as Parameters<typeof trpcClient.items.putMany.mutate>[0])
      return
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
    const queue = await readQueue()
    if (queue.length === 0) {
      return
    }

    const remaining = [...queue]

    while (remaining.length > 0) {
      const mutation = remaining[0]

      try {
        await executeMutation(mutation)
        remaining.shift()
        await writeQueue(remaining)
      } catch (error) {
        if (isLikelyNetworkError(error)) {
          break
        }

        if (isVersionConflictError(error)) {
          // Conflict is handled by normal merge/retry flow on next foreground mutation.
          remaining.shift()
          await writeQueue(remaining)
          continue
        }

        // Unknown failure: drop item to avoid infinite loop but continue processing.
        remaining.shift()
        await writeQueue(remaining)
      }
    }
  } finally {
    processing = false
  }
}
