import { setVapidDetails, sendNotification } from 'web-push'
import type { WebPushSubscription } from '../../shared/apiTypes'

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

export async function sendPushNotifications(
  subscriptions: WebPushSubscription[],
  payload: { title: string, body: string },
) {
  ensureVapidConfigured()

  const failedEndpoints: string[] = []

  for (const subscription of subscriptions) {
    try {
      await sendNotification(subscription, JSON.stringify(payload))
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode
      if (statusCode === 404 || statusCode === 410) {
        failedEndpoints.push(subscription.endpoint)
      } else {
        throw error
      }
    }
  }

  return { failedEndpoints }
}
