import {
  addPushSubscription,
  deletePushSubscription,
  updateReminderSettings,
  getReminderSettings,
} from '../api/notificationClient'
import env from '../env'
import { createLogger } from 'src/utils/logger'

const log = createLogger('pushNotifications')

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

/**
 * Remembers which account this browser's push subscription was registered to. A browser has one
 * subscription however many accounts use it, and registering the same endpoint to a second account
 * would show anyone who can read the account records that the two share a device.
 */
const SUBSCRIPTION_OWNER_KEY = 'FlockPushSubscriptionOwner'

type Ownership = 'this' | 'other' | 'unknown'

function getOwnership(account: string, subscription: PushSubscription): Ownership {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SUBSCRIPTION_OWNER_KEY) ?? 'null')
    if (
      parsed && typeof parsed === 'object'
      && 'account' in parsed && typeof parsed.account === 'string'
      && 'endpoint' in parsed && parsed.endpoint === subscription.endpoint
    ) {
      return parsed.account === account ? 'this' : 'other'
    }
  } catch (error) {
    log.warn('Failed to read the push subscription owner', error)
  }
  // Subscriptions made before the owner was recorded, or that the browser has since replaced
  return 'unknown'
}

function setOwner(account: string, endpoint: string) {
  try {
    localStorage.setItem(SUBSCRIPTION_OWNER_KEY, JSON.stringify({ account, endpoint }))
  } catch (error) {
    log.warn('Failed to record the push subscription owner', error)
  }
}

function clearOwner() {
  try {
    localStorage.removeItem(SUBSCRIPTION_OWNER_KEY)
  } catch (error) {
    log.warn('Failed to clear the push subscription owner', error)
  }
}

/**
 * Unsubscribes the existing subscription and makes a new one. The old endpoint is removed from this
 * account unless it is known to be another account's, since sending that would link the two. Once
 * unsubscribed, the push service rejects the old endpoint, and the notifier drops it from
 * whichever account still holds it.
 */
async function replaceSubscription(
  account: string,
  pushManager: PushManager,
  existing: PushSubscription | null,
  key: Uint8Array<ArrayBuffer>,
  removeFromServer: boolean,
) {
  if (existing) {
    if (removeFromServer) {
      await deletePushSubscription(account, existing.endpoint)
    }
    clearOwner()
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
  if (!existing) {
    return replaceSubscription(account, registration.pushManager, null, keyBytes, false)
  }
  // A subscription of unknown ownership may be another account's, so it is replaced too
  const ownership = getOwnership(account, existing)
  if (ownership === 'this' && !isForOtherKey(existing, keyBytes)) {
    return existing
  }
  return replaceSubscription(account, registration.pushManager, existing, keyBytes, ownership !== 'other')
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
  setOwner(account, subscriptionJson.endpoint)
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
  // Another account's subscription is left for that account to refresh. One of unknown ownership was
  // most likely made by this account before owners were recorded.
  if (getOwnership(account, existing) === 'other') {
    return false
  }
  await registerSubscription(account, await replaceSubscription(account, pushManager, existing, keyBytes, true))
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

/**
 * Turns reminders off for this device. The browser unsubscribes even when the server can't be
 * reached, so the device stops receiving pushes either way; the server drops the endpoint the next
 * time the push service rejects it.
 *
 * With `serverGone`, for an account that has just been deleted from the server, it only unsubscribes
 * the browser: the server's copy of the reminders went with the account, and asking it about an
 * account it no longer has would be taken for an expired session.
 */
export async function unsubscribe(account: string, { serverGone = false } = {}) {
  const registration = await navigator.serviceWorker.getRegistration()
  if (registration && 'pushManager' in registration && registration.pushManager) {
    const existing = await registration.pushManager.getSubscription()
    // Another account's subscription is left alone, so its reminders keep arriving
    if (existing && getOwnership(account, existing) !== 'other') {
      try {
        if (!serverGone) {
          await deletePushSubscription(account, existing.endpoint)
        }
      } finally {
        clearOwner()
        await existing.unsubscribe()
      }
    }
  }

  if (serverGone) return
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
    log.error('Failed to sync reminder timezone', error)
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
    log.error('Failed to clear reminder notifications:', error)
  }
}
