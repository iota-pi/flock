/// <reference lib="webworker" />
import { precacheAndRoute } from 'workbox-precaching'
import {
  OFFLINE_QUEUE_SYNC_TAG,
  getActiveSessionToken,
  readQueue,
  writeQueue,
  type QueuedMutation,
} from './sync/offlineQueueStore'
import {
  hasVersionConflictSignature,
  isVersionConflictError,
} from './shared/syncErrors'

declare const self: ServiceWorkerGlobalScope

precacheAndRoute(self.__WB_MANIFEST)

type PushPayload = {
  title?: string,
  body?: string,
  icon?: string,
  badge?: string,
  url?: string,
}

self.addEventListener('push', event => {
  const fallbackTitle = 'Prayer reminder'
  const fallbackBody = 'Time to pray for your flock.'

  let payload: PushPayload = {}
  if (event.data) {
    try {
      payload = event.data.json() as PushPayload
    } catch {
      payload = {
        body: event.data.text(),
      }
    }
  }

  const title = payload.title || fallbackTitle
  const body = payload.body || fallbackBody

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({
        includeUncontrolled: true,
        type: 'window',
      })

      const hasVisibleFocusedClient = clientList.some(client => {
        const focused = 'focused' in client ? Boolean(client.focused) : true
        return client.visibilityState === 'visible' && focused
      })

      if (hasVisibleFocusedClient) {
        for (const client of clientList) {
          client.postMessage({
            type: 'PASSIVE_PUSH_NOTIFICATION',
            payload: {
              title,
              body,
              url: payload.url || '/',
            },
          })
        }
        return
      }

      await self.registration.showNotification(title, {
        body,
        icon: payload.icon || '/flock.png',
        badge: payload.badge || '/flock.png',
        data: {
          url: payload.url || '/',
        },
      })
    })(),
  )
})

self.addEventListener('notificationclick', event => {
  event.notification.close()

  const targetUrl = (event.notification.data as { url?: string } | undefined)?.url || '/'

  event.waitUntil(
    self.clients.matchAll({
      includeUncontrolled: true,
      type: 'window',
    }).then(clientList => {
      const matchingClient = clientList.find(client => 'focus' in client)

      if (matchingClient) {
        return matchingClient.focus().then(() => {
          if ('navigate' in matchingClient) {
            return matchingClient.navigate(targetUrl)
          }
          return undefined
        })
      }

      return self.clients.openWindow(targetUrl)
    }),
  )
})

function isLikelyNetworkError(error: unknown): boolean {
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

function getProcedurePath(mutationType: QueuedMutation['mutationType']) {
  switch (mutationType) {
    case 'items.put':
      return 'items.put'
    case 'items.putMany':
      return 'items.putMany'
    case 'accounts.updateMetadata':
      return 'accounts.updateMetadata'
    default:
      return null
  }
}

async function executeMutation(
  mutation: QueuedMutation,
  token: string,
): Promise<{ success: boolean, conflict: boolean, status: number }> {
  const procedurePath = getProcedurePath(mutation.mutationType)
  if (!procedurePath) {
    throw new Error(`Unknown offline mutation type: ${mutation.mutationType}`)
  }

  const response = await fetch(`${mutation.endpoint}/trpc/${procedurePath}`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ json: mutation.payload }),
  })

  const responseText = await response.text()
  const conflictByStatus = response.status === 400 || response.status === 409
  const conflictByBody = hasVersionConflictSignature(responseText)

  if (response.ok && !conflictByBody) {
    return { success: true, conflict: false, status: response.status }
  }

  return {
    success: false,
    conflict: conflictByStatus || conflictByBody,
    status: response.status,
  }
}

async function processOfflineQueue() {
  const queue = await readQueue()
  if (queue.length === 0) {
    return
  }

  const token = await getActiveSessionToken()
  if (!token) {
    await writeQueue(queue)
    return
  }

  const nextQueue: QueuedMutation[] = []

  for (let index = 0; index < queue.length; index += 1) {
    const mutation = queue[index]
    const normalizedMutation: QueuedMutation = {
      ...mutation,
      conflict: false,
      lastConflictAt: undefined,
      lastErrorStatus: undefined,
    }

    try {
      const result = await executeMutation(normalizedMutation, token)
      if (result.success) {
        continue
      }

      if (result.conflict) {
        nextQueue.push({
          ...normalizedMutation,
          conflict: true,
          lastConflictAt: Date.now(),
          lastErrorStatus: result.status,
        })
        continue
      }

      if (result.status === 401) {
        console.warn('Background sync paused: Session expired. Waiting for user to reopen app.')
        nextQueue.push(...queue.slice(index))
        break
      }

      if (result.status === 0) {
        nextQueue.push(normalizedMutation, ...queue.slice(index + 1))
        break
      }
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

      // Drop unknown failures to avoid deadlocking the queue.
    }
  }

  await writeQueue(nextQueue)
}

self.addEventListener('sync', event => {
  const syncEvent = event as Event & {
    tag?: string
    waitUntil: (promise: Promise<unknown>) => void
  }

  if (syncEvent.tag === OFFLINE_QUEUE_SYNC_TAG) {
    syncEvent.waitUntil(processOfflineQueue())
  }
})
