/// <reference lib="webworker" />
import { ExpirationPlugin } from 'workbox-expiration'
import { createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { CacheFirst, NetworkOnly } from 'workbox-strategies'

declare const self: ServiceWorkerGlobalScope

precacheAndRoute(self.__WB_MANIFEST)

const MIGRATE_PATH = /^\/migrate(\/|$)/

// Serve the app shell for client-side routes (e.g. /people) so reloads and deep links work offline
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html'), {
  denylist: [MIGRATE_PATH],
}))

const MIGRATE_OFFLINE_PAGE = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Flock</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px;
        box-sizing: border-box; background: #202020; color: #fff; font-family: system-ui, sans-serif; }
      main { max-width: 420px; text-align: center; line-height: 1.5; }
      button { margin-top: 16px; padding: 8px 20px; border: 0; border-radius: 4px; background: #00796b;
        color: #fff; font: inherit; cursor: pointer; }
    </style>
  </head>
  <body>
    <main>
      <h1>You're offline</h1>
      <p>Flock needs to update your data, and that needs an internet connection. Connect and try again.</p>
      <button onclick="location.reload()">Try again</button>
    </main>
  </body>
</html>`

// The migration app isn't precached (only devices with old data need it), and it needs the server
// anyway, so offline it gets a page that says so
registerRoute(
  ({ request, url }) => request.mode === 'navigate' && MIGRATE_PATH.test(url.pathname),
  new NetworkOnly({
    plugins: [{
      handlerDidError: async () => new Response(MIGRATE_OFFLINE_PAGE, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }),
    }],
  }),
)

// Built assets left out of the precache (the migration app and the password-strength dictionaries)
// are cached when first used. Their names are content hashed, so a cached copy never goes stale.
registerRoute(
  ({ url }) => url.origin === self.location.origin && url.pathname.startsWith('/assets/'),
  new CacheFirst({
    cacheName: 'lazy-assets',
    plugins: [
      {
        // A missing file is answered with the app shell, which mustn't be cached as the asset
        cacheWillUpdate: async ({ response }) => (
          response.ok && !response.headers.get('Content-Type')?.includes('text/html') ? response : null
        ),
      },
      new ExpirationPlugin({ maxEntries: 20, purgeOnQuotaError: true }),
    ],
  }),
)

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

      const icon = new URL(payload.icon || '/android-chrome-192x192.png', self.location.origin).href
      const badge = new URL(payload.badge || '/badge-96x96.png', self.location.origin).href
      await self.registration.showNotification(title, {
        body,
        icon,
        badge,
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

      // The migration app doesn't handle the navigate message
      const matchingClient = clientList.find(client => (
        'focus' in client && !new URL(client.url).pathname.startsWith('/migrate')
      ))

      if (matchingClient) {
        await matchingClient.focus()
        // The app routes itself. A full navigation (client.navigate) would reload it and lock the vault.
        matchingClient.postMessage({
          type: 'NOTIFICATION_CLICK_NAVIGATE',
          url: targetUrl,
        })
        return
      }

      await self.clients.openWindow(absoluteUrl)
    })(),
  )
})

self.addEventListener('message', event => {
  // Sent by the page (registerSW's updateSW) when it is ready for this version to take over
  if (event.data?.type === 'SKIP_WAITING') {
    void self.skipWaiting()
    return
  }

  if (event.data?.type === 'CLEAR_REMINDER_NOTIFICATIONS') {
    event.waitUntil(
      (async () => {
        const notifications = await self.registration.getNotifications()
        for (const notification of notifications) {
          if (!notification.tag || notification.tag.startsWith('prayer-reminder')) {
            notification.close()
          }
        }
      })(),
    )
  }
})
