import {
  addPushSubscription,
  deletePushSubscription,
  updateReminderSettings,
  getReminderSettings,
} from '../api/vault'
import env from '../env'

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

export async function subscribe(account: string, hours: number[]) {
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

  await addPushSubscription(account, {
    endpoint: subscriptionJson.endpoint,
    keys: {
      auth: subscriptionJson.keys.auth,
      p256dh: subscriptionJson.keys.p256dh,
    },
  })

  const firstHour = hours[0] ?? 8
  await updateReminderSettings(account, {
    reminderEnabled: true,
    reminderTime: `${String(firstHour).padStart(2, '0')}:00`,
    reminderTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  })
}

export async function unsubscribe(account: string) {
  const registration = await navigator.serviceWorker.getRegistration()
  const existing = await registration?.pushManager.getSubscription()
  if (existing) {
    await deletePushSubscription(account, existing.endpoint)
    await existing.unsubscribe()
  }

  await updateReminderSettings(account, {
    reminderEnabled: false,
    reminderTime: '08:00',
    reminderTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  })
}

export async function checkSubscription(account: string) {
  const authorized = Notification.permission === 'granted'
  if (!authorized) {
    return null
  }

  const settings = await getReminderSettings(account)
  if (!settings.reminderEnabled) {
    return null
  }

  const [hour] = settings.reminderTime.split(':')
  const parsedHour = Number(hour)
  return {
    hours: Number.isInteger(parsedHour) ? [parsedHour] : [8],
  }
}

export async function syncReminderTimezone(account: string): Promise<boolean> {
  try {
    const settings = await getReminderSettings(account)
    if (!settings.reminderEnabled) {
      return false
    }

    const currentTz = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (currentTz && settings.reminderTimezone !== currentTz) {
      await updateReminderSettings(account, {
        reminderEnabled: true,
        reminderTime: settings.reminderTime,
        reminderTimezone: currentTz,
      })
      return true
    }
    return false
  } catch (error) {
    console.error('Failed to sync reminder timezone', error)
    return false
  }
}
