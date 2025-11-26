import { initializeApp } from 'firebase/app'
import { getMessaging, getToken as firebaseGetToken } from 'firebase/messaging'
import { deleteSubscription, getSubscription, setSubscription } from '../api/Vault'
import env from '../env'
import firebaseConfig from './firebase-config'

export const app = initializeApp(firebaseConfig)

async function getToken() {
  const messaging = getMessaging()
  return firebaseGetToken(
    messaging,
    {
      vapidKey: env.VAPID_PUBLIC_KEY,
      serviceWorkerRegistration: await navigator.serviceWorker.getRegistration(),
    },
  )
}

export async function subscribe(hours: number[]) {
  const token = await getToken()
  await setSubscription({
    failures: 0,
    hours,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    token,
  })
}

export async function unsubscribe() {
  const token = await getToken()
  await deleteSubscription(token)
}

export async function checkSubscription() {
  const authorized = Notification.permission === 'granted'
  if (!authorized) {
    return null
  }
  const token = await getToken()
  const existing = await getSubscription(token)
  return existing
}
