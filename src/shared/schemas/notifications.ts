import { z } from 'zod'

/** Most push subscriptions an account keeps. Adding another drops the oldest. */
export const MAX_PUSH_SUBSCRIPTIONS = 10

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
  account: z.string().min(1),
  endpoint: z.string().max(MAX_ENDPOINT_LENGTH).refine(isAllowedPushEndpoint, 'Not a known push service endpoint'),
  keys: z.object({
    p256dh: z.string().min(1).max(MAX_KEY_LENGTH),
    auth: z.string().min(1).max(MAX_KEY_LENGTH),
  }),
})

export const PushSubscriptionDeleteBodySchema = z.object({
  account: z.string().min(1),
  endpoint: z.string().min(1).max(MAX_ENDPOINT_LENGTH),
})

export const ReminderSettingsBodySchema = z.object({
  account: z.string().min(1),
  reminderEnabled: z.boolean(),
  reminderTime: z.string().min(5).max(5),
  reminderTimezone: z.string().min(1),
})

export const SnoozeRemindersBodySchema = z.object({
  account: z.string().min(1),
  snoozeUntilDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
})
