import type { WebPushSubscription } from '../types'

/**
 * One SQS message per push subscription, so a failed send retries only that subscription and the
 * account's other devices don't get a duplicate reminder.
 */
export type ReminderMessage = {
  accountId: string,
  subscription: WebPushSubscription,
  /** Web push Topic header; a push service holding an undelivered reminder replaces it */
  topic: string,
}

/** One topic per local day (topics are at most 32 URL-safe base64 characters) */
export function getReminderTopic(localDate: string) {
  return `reminder-${localDate}`
}
