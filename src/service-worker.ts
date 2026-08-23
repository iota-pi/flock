/// <reference lib="webworker" />
import { precacheAndRoute } from 'workbox-precaching'

declare const self: ServiceWorkerGlobalScope

precacheAndRoute(self.__WB_MANIFEST)

type PushPayload = {
  title?: string
  body?: string
  icon?: string
  badge?: string
  url?: string
  tag?: string
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
        tag: payload.tag || 'prayer-reminder',
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
  const absoluteUrl = new URL(targetUrl, self.location.origin).href

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({
        includeUncontrolled: true,
        type: 'window',
      })

      const matchingClient = clientList.find(client => 'focus' in client)

      if (matchingClient) {
        await matchingClient.focus()
        matchingClient.postMessage({
          type: 'NOTIFICATION_CLICK_NAVIGATE',
          url: targetUrl,
        })

        if ('navigate' in matchingClient) {
          try {
            await matchingClient.navigate(absoluteUrl)
          } catch {
            // Ignore if browser restricts client.navigate
          }
        }
        return
      }

      await self.clients.openWindow(absoluteUrl)
    })(),
  )
})
