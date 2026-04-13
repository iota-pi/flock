/// <reference lib="webworker" />
import { precacheAndRoute } from 'workbox-precaching'
import env from './env'
import {
  appendBackgroundSyncPushCommits,
  BACKGROUND_SYNC_PUSH_TAG,
  listBackgroundSyncPushBatches,
  removeBackgroundSyncPushBatches,
  type BackgroundSyncPushBatch,
} from './sync/backgroundSyncPushQueue'
import { getActiveSessionToken } from './sync/workerAuthStore'

declare const self: ServiceWorkerGlobalScope

precacheAndRoute(self.__WB_MANIFEST)

type PushPayload = {
  title?: string
  body?: string
  icon?: string
  badge?: string
  url?: string
}

type SyncEventLike = ExtendableEvent & {
  tag?: string
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600)
}

async function pushBackgroundSyncBatch(batch: BackgroundSyncPushBatch): Promise<'success' | 'drop' | 'retry'> {
  if (!env.VAULT_ENDPOINT) {
    return 'drop'
  }
  // Grab the freshest token from IndexedDB. Fallback to the batch token for legacy payloads.
  const freshToken = await getActiveSessionToken()
  const activeToken = freshToken || batch.authToken

  // If no token exists at all, the user logged out completely. Drop the sync payload.
  if (!activeToken) {
    return 'drop'
  }

  try {
    const response = await fetch(`${env.VAULT_ENDPOINT}/sync/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${activeToken}`,
      },
      body: JSON.stringify({
        account: batch.account,
        messages: batch.messages.map(message => ({
          itemId: message.itemId,
          encryptedMessage: message.encryptedMessage,
        })),
      }),
    })

    if (response.ok) {
      return 'success'
    }

    return isRetryableHttpStatus(response.status) ? 'retry' : 'drop'
  } catch {
    return 'retry'
  }
}

async function notifyClientsOfBackgroundSyncPushes(itemIdsByAccount: Map<string, Set<string>>): Promise<void> {
  if (itemIdsByAccount.size === 0) {
    return
  }

  const clientList = await self.clients.matchAll({
    includeUncontrolled: true,
    type: 'window',
  })

  for (const [account, itemIds] of itemIdsByAccount) {
    const payload = {
      type: 'FLOCK_BACKGROUND_SYNC_PUSHED',
      account,
      itemIds: Array.from(itemIds),
    }

    for (const client of clientList) {
      client.postMessage(payload)
    }
  }
}

async function handleBackgroundSyncPush(): Promise<void> {
  const pendingBatches = await listBackgroundSyncPushBatches()
  if (pendingBatches.length === 0) {
    return
  }

  const processedBatchIds: string[] = []
  const commits: Array<{ account: string; itemId: string; nextSyncState: string; committedAt: number }> = []
  const itemIdsByAccount = new Map<string, Set<string>>()

  let shouldRetry = false

  for (const batch of pendingBatches) {
    const outcome = await pushBackgroundSyncBatch(batch)

    if (outcome === 'success') {
      processedBatchIds.push(batch.id)

      for (const message of batch.messages) {
        commits.push({
          account: batch.account,
          itemId: message.itemId,
          nextSyncState: message.nextSyncState,
          committedAt: Date.now(),
        })

        const existingIds = itemIdsByAccount.get(batch.account)
        if (existingIds) {
          existingIds.add(message.itemId)
        } else {
          itemIdsByAccount.set(batch.account, new Set([message.itemId]))
        }
      }

      continue
    }

    if (outcome === 'drop') {
      processedBatchIds.push(batch.id)
      continue
    }

    shouldRetry = true
    break
  }

  if (processedBatchIds.length > 0) {
    await removeBackgroundSyncPushBatches(processedBatchIds)
  }

  if (commits.length > 0) {
    await appendBackgroundSyncPushCommits(commits)
    await notifyClientsOfBackgroundSyncPushes(itemIdsByAccount)
  }

  if (shouldRetry) {
    throw new Error('Background sync push will retry')
  }
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

self.addEventListener('sync', event => {
  const syncEvent = event as SyncEventLike
  if (syncEvent.tag !== BACKGROUND_SYNC_PUSH_TAG) {
    return
  }

  syncEvent.waitUntil(handleBackgroundSyncPush())
})
