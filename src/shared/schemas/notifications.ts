import { z } from 'zod'
import { AccountIdInputSchema, MAX_LOGIN_DEVICES } from '@vault/shared'

/** Most push subscriptions an account keeps, one per device as with logins. Adding another drops the oldest. */
export const MAX_PUSH_SUBSCRIPTIONS = MAX_LOGIN_DEVICES

/** Real endpoints are a few hundred characters (WNS's are the longest) */
const MAX_ENDPOINT_LENGTH = 1024

/** The keys are base64url: an 87-character P-256 public key and a 22-character auth secret */
const MAX_KEY_LENGTH = 128

/**
 * Hosts of the push services browsers use (FCM for Chrome, Mozilla's autopush, Apple's and Windows'
 * WNS for Edge). The notifier POSTs to every stored endpoint, so accepting any URL would let anyone
 * make it send requests wherever they like.
 */
const PUSH_SERVICE_HOSTS = ['fcm.googleapis.com']
const PUSH_SERVICE_HOST_SUFFIXES = ['.push.services.mozilla.com', '.push.apple.com', '.notify.windows.com']

/** Whether `endpoint` is an https URL on a known push service, with no port or credentials */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  if (endpoint.length > MAX_ENDPOINT_LENGTH) {
    return false
  }
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') {
    return false
  }
  const host = url.hostname
  return PUSH_SERVICE_HOSTS.includes(host) || PUSH_SERVICE_HOST_SUFFIXES.some(suffix => host.endsWith(suffix))
}

const WebPushSubscriptionKeysSchema = z.object({
  p256dh: z.string(),
  auth: z.string(),
})

export const WebPushSubscriptionSchema = z.object({
  endpoint: z.string(),
  keys: WebPushSubscriptionKeysSchema,
})
/** Account fields Flock stores alongside the vault's own account data. */
export const FlockAccountFieldsSchema = z.object({
  pushSubscriptions: z.array(WebPushSubscriptionSchema).optional(),
  reminderEnabled: z.boolean().optional(),
  reminderTime: z.string().optional(),
  reminderTimezone: z.string().optional(),
  snoozeRemindersUntil: z.string().nullable().optional(),
  /** Puts the account in the notifier's index while its reminders are on (see REMINDER_INDEX) */
  reminderIndex: z.literal('on').optional(),
  /** Plaintext settings from before the encrypted settings document. Cleared once a client migrates them. */
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export const ReminderSettingsResponseSchema = z.object({
  success: z.boolean(),
  reminderEnabled: z.boolean(),
  reminderTime: z.string(),
  reminderTimezone: z.string(),
})

export const PushSubscriptionBodySchema = z.object({
  account: AccountIdInputSchema,
  endpoint: z.string().max(MAX_ENDPOINT_LENGTH).refine(isAllowedPushEndpoint, 'Not a known push service endpoint'),
  keys: z.object({
    p256dh: z.string().min(1).max(MAX_KEY_LENGTH),
    auth: z.string().min(1).max(MAX_KEY_LENGTH),
  }),
})

export const PushSubscriptionDeleteBodySchema = z.object({
  account: AccountIdInputSchema,
  endpoint: z.string().min(1).max(MAX_ENDPOINT_LENGTH),
})

/** IANA names are at most about 30 characters */
const MAX_TIMEZONE_LENGTH = 64

/**
 * Whether this realm's `Intl` knows `timeZone`, which is what the notifier needs. Unlike
 * `Intl.supportedValuesOf('timeZone')`, it accepts `UTC` (the default) and the aliases browsers
 * may report, such as `Asia/Kolkata` where Node lists only `Asia/Calcutta`.
 */
export function isKnownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

export const ReminderSettingsBodySchema = z.object({
  account: AccountIdInputSchema,
  reminderEnabled: z.boolean(),
  /** 24-hour HH:MM */
  reminderTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  reminderTimezone: z.string().min(1).max(MAX_TIMEZONE_LENGTH).refine(isKnownTimeZone, 'Unknown time zone'),
})

export const SnoozeRemindersBodySchema = z.object({
  account: AccountIdInputSchema,
  snoozeUntilDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
})
