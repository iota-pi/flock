import {
  addPushSubscription,
  deletePushSubscription,
  updateReminderSettings,
  getReminderSettings,
} from '../api/notificationClient'
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

/**
 * Whether the browser made this subscription with a different VAPID key (it was rotated, or another
 * build made it). The push service rejects every message sent to such a subscription. A browser
 * that doesn't report the key is taken to have the current one.
 */
function isForOtherKey(subscription: PushSubscription, key: Uint8Array) {
  const subscriptionKey = subscription.options?.applicationServerKey
  if (!subscriptionKey) {
    return false
  }
  const bytes = new Uint8Array(subscriptionKey)
  return bytes.length !== key.length || bytes.some((byte, index) => byte !== key[index])
}

async function replaceSubscription(account: string, pushManager: PushManager, existing: PushSubscription | null, key: Uint8Array<ArrayBuffer>) {
  if (existing) {
    await deletePushSubscription(account, existing.endpoint)
    await existing.unsubscribe()
  }
  return pushManager.subscribe({
    applicationServerKey: key,
    userVisibleOnly: true,
  })
}

async function getPushSubscription(account: string, key: string) {
  const registration = await navigator.serviceWorker.getRegistration()
  if (!registration) {
    throw new Error('Service worker registration not found')
  }
  if (!('pushManager' in registration) || !registration.pushManager) {
    throw new Error('Push manager is not supported in this browser')
  }

  if (!key) {
    throw new Error('Missing VITE_VAPID_PUBLIC_KEY')
  }
  const keyBytes = fromBase64Url(key)

  const existing = await registration.pushManager.getSubscription()
  if (existing && !isForOtherKey(existing, keyBytes)) {
    return existing
  }
  return replaceSubscription(account, registration.pushManager, existing, keyBytes)
}

async function registerSubscription(account: string, subscription: PushSubscription) {
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
}

/**
 * Replaces this device's push subscription if it was made with a different VAPID key, so that
 * reminders reach it again without the user turning them off and on. Returns whether it did.
 */
export async function refreshPushSubscription(account: string, key = env.VAPID_PUBLIC_KEY): Promise<boolean> {
  if (!('Notification' in window) || Notification.permission !== 'granted' || !('serviceWorker' in navigator)) {
    return false
  }
  const pushManager = (await navigator.serviceWorker.getRegistration())?.pushManager
  if (!pushManager || !key) {
    return false
  }
  const keyBytes = fromBase64Url(key)

  const existing = await pushManager.getSubscription()
  if (!existing || !isForOtherKey(existing, keyBytes)) {
    return false
  }
  await registerSubscription(account, await replaceSubscription(account, pushManager, existing, keyBytes))
  return true
}

export async function subscribe(account: string, hours: number[], key = env.VAPID_PUBLIC_KEY) {
  if (!('Notification' in window) || !('serviceWorker' in navigator)) {
    throw new Error('Push notifications are not supported in this browser')
  }

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    throw new Error('Notification permission was not granted')
  }

  await registerSubscription(account, await getPushSubscription(account, key))

  const firstHour = hours[0] ?? 8
  await updateReminderSettings(account, {
    reminderEnabled: true,
    reminderTime: `${String(firstHour).padStart(2, '0')}:00`,
    reminderTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  })
}

export async function unsubscribe(account: string) {
  const registration = await navigator.serviceWorker.getRegistration()
  if (registration && 'pushManager' in registration && registration.pushManager) {
    const existing = await registration.pushManager.getSubscription()
    if (existing) {
      await deletePushSubscription(account, existing.endpoint)
      await existing.unsubscribe()
    }
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

export async function clearReminderNotifications(): Promise<void> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return
  }

  try {
    const registration = await navigator.serviceWorker.getRegistration()
    if (!registration) {
      return
    }

    if (registration.active) {
      registration.active.postMessage({ type: 'CLEAR_REMINDER_NOTIFICATIONS' })
    } else if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_REMINDER_NOTIFICATIONS' })
    }

    if ('getNotifications' in registration) {
      const notifications = await registration.getNotifications()
      for (const notification of notifications) {
        if (!notification.tag || notification.tag.startsWith('prayer-reminder')) {
          notification.close()
        }
      }
    }
  } catch (error) {
    console.error('Failed to clear reminder notifications:', error)
  }
}
