import {
  sendNotification,
  setVapidDetails,
} from 'web-push'
import type { WebPushSubscription } from '../types'
import { readSecret } from '../secrets'
import { isAllowedPushEndpoint } from 'src/shared/schemas/notifications'

/** How long a push service's socket may go idle before the send fails */
const PUSH_TIMEOUT_MS = 10_000

let vapidConfigured = false

function ensureVapidConfigured() {
  if (vapidConfigured) {
    return
  }

  const vapidSubject = readSecret('VAPID_SUBJECT')
  const vapidPublicKey = readSecret('VAPID_PUBLIC_KEY')
  const vapidPrivateKey = readSecret('VAPID_PRIVATE_KEY')

  if (!vapidSubject || !vapidPublicKey || !vapidPrivateKey) {
    throw new Error('Missing VAPID_SUBJECT, VAPID_PUBLIC_KEY, or VAPID_PRIVATE_KEY')
  }

  setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey)
  vapidConfigured = true
}

export async function sendPushNotification(
  subscription: WebPushSubscription,
  payload: { title: string, body: string },
  { topic, ttl }: { topic?: string, ttl?: number } = {},
) {
  if (!isAllowedPushEndpoint(subscription.endpoint)) {
    throw new Error('Refusing to send to an endpoint that is not a known push service')
  }
  ensureVapidConfigured()
  await sendNotification(subscription, JSON.stringify(payload), { timeout: PUSH_TIMEOUT_MS, topic, TTL: ttl })
}