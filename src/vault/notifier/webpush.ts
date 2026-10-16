import {
  sendNotification,
  setVapidDetails,
} from 'web-push'
import type { WebPushSubscription } from '../types'

/** How long a push service's socket may go idle before the send fails */
const PUSH_TIMEOUT_MS = 10_000

let vapidConfigured = false

function ensureVapidConfigured() {
  if (vapidConfigured) {
    return
  }

  const vapidSubject = process.env.VAPID_SUBJECT
  const vapidPublicKey = process.env.VAPID_PUBLIC_KEY
  const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY

  if (!vapidSubject || !vapidPublicKey || !vapidPrivateKey) {
    throw new Error('Missing VAPID_SUBJECT, VAPID_PUBLIC_KEY, or VAPID_PRIVATE_KEY')
  }

  setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey)
  vapidConfigured = true
}

export async function sendPushNotification(
  subscription: WebPushSubscription,
  payload: { title: string, body: string },
) {
  ensureVapidConfigured()
  await sendNotification(subscription, JSON.stringify(payload), { timeout: PUSH_TIMEOUT_MS })
}