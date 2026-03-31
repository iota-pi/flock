import {
  addPushSubscription,
  deletePushSubscription,
  updateReminderSettings,
} from '../api/vault'
import env from '../env'
import { getReminderSettings } from '../api/vault/client'

function fromBase64Url(base64Url: string) {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4)
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) {
    bytes[i] = raw.charCodeAt(i)
  }
  return bytes
}

async function getPushSubscription() {
  const registration = await navigator.serviceWorker.getRegistration()
  if (!registration) {
    throw new Error('Service worker registration not found')
  }

  const existing = await registration.pushManager.getSubscription()
  if (existing) {
    return existing
  }

  const key = env.VAPID_PUBLIC_KEY
  if (!key) {
    throw new Error('Missing VITE_VAPID_PUBLIC_KEY')
  }

  return registration.pushManager.subscribe({
    applicationServerKey: fromBase64Url(key),
    userVisibleOnly: true,
  })
}

export async function subscribe(hours: number[]) {
  if (!('Notification' in window) || !('serviceWorker' in navigator)) {
    throw new Error('Push notifications are not supported in this browser')
  }

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    throw new Error('Notification permission was not granted')
  }

  const subscription = await getPushSubscription()
  const subscriptionJson = subscription.toJSON()
  if (!subscriptionJson.endpoint || !subscriptionJson.keys?.auth || !subscriptionJson.keys?.p256dh) {
    throw new Error('Failed to create push subscription')
  }

  await addPushSubscription({
    endpoint: subscriptionJson.endpoint,
    keys: {
      auth: subscriptionJson.keys.auth,
      p256dh: subscriptionJson.keys.p256dh,
    },
  })

  const firstHour = hours[0] ?? 8
  await updateReminderSettings({
    reminderEnabled: true,
    reminderTime: `${String(firstHour).padStart(2, '0')}:00`,
    reminderTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  })
}

export async function unsubscribe() {
  const registration = await navigator.serviceWorker.getRegistration()
  const existing = await registration?.pushManager.getSubscription()
  if (existing) {
    await deletePushSubscription(existing.endpoint)
    await existing.unsubscribe()
  }

  await updateReminderSettings({
    reminderEnabled: false,
    reminderTime: '08:00',
    reminderTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  })
}

export async function checkSubscription() {
  const authorized = Notification.permission === 'granted'
  if (!authorized) {
    return null
  }

  const settings = await getReminderSettings()
  if (!settings.reminderEnabled) {
    return null
  }

  const [hour] = settings.reminderTime.split(':')
  const parsedHour = Number(hour)
  return {
    hours: Number.isInteger(parsedHour) ? [parsedHour] : [8],
  }
}
