import { z } from 'zod'


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
})

export const ReminderSettingsResponseSchema = z.object({
  success: z.boolean(),
  reminderEnabled: z.boolean(),
  reminderTime: z.string(),
  reminderTimezone: z.string(),
})

export const PushSubscriptionBodySchema = z.object({
  account: z.string().min(1),
  endpoint: z.string().min(1),
  keys: WebPushSubscriptionKeysSchema,
})

export const PushSubscriptionDeleteBodySchema = z.object({
  account: z.string().min(1),
  endpoint: z.string().min(1),
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
