import env from '../env'
import { trpcClient } from './trpcClient'
import { getVaultSession } from './Vault'
import { getApiAuthToken } from './runtime'
import {
  getMutationId,
  OFFLINE_QUEUE_SYNC_TAG,
  type QueuedMutation,
  readQueue,
  writeQueue,
} from './offlineQueueStore'

let processing = false

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

export async function enqueueMutation(mutationType: string, payload: unknown) {
  const session = getVaultSession() || getApiAuthToken()
  if (!session || !env.VAULT_ENDPOINT) {
    throw new Error('Cannot queue offline mutation without active session')
  }

  const queue = await readQueue()
  queue.push({
    id: getMutationId(),
    mutationType,
    payload,
    session,
    endpoint: env.VAULT_ENDPOINT,
    conflict: false,
  })
  await writeQueue(queue)

  await registerBackgroundSync()
}

async function registerBackgroundSync() {
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

    const nextQueue: QueuedMutation[] = []

    for (let index = 0; index < queue.length; index += 1) {
      const mutation = queue[index]
      const normalizedMutation = {
        ...mutation,
        conflict: false,
        lastConflictAt: undefined,
        lastErrorStatus: undefined,
      }

      try {
        await executeMutation(normalizedMutation)
      } catch (error) {
        if (isLikelyNetworkError(error)) {
          nextQueue.push(normalizedMutation, ...queue.slice(index + 1))
          break
        }

        if (isVersionConflictError(error)) {
          nextQueue.push({
            ...normalizedMutation,
            conflict: true,
            lastConflictAt: Date.now(),
          })
          continue
        }

        // Unknown errors are dropped to avoid permanent queue deadlock.
      }
    }

    await writeQueue(nextQueue)
  } finally {
    processing = false
  }
}
