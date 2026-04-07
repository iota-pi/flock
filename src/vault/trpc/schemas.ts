import { z } from 'zod'

export const ItemTypeSchema = z.enum(['person', 'group', 'topic'])

export const WebPushSubscriptionKeysSchema = z.object({
  p256dh: z.string(),
  auth: z.string(),
})

export const WebPushSubscriptionSchema = z.object({
  endpoint: z.string().min(1),
  keys: WebPushSubscriptionKeysSchema,
})

export const CreateAccountBodySchema = z.object({
  salt: z.string().min(1),
  authToken: z.string().min(1),
})

export const LoginBodySchema = z.object({
  account: z.string().min(1),
  authToken: z.string().min(1),
})

export const AccountInputSchema = z.object({
  account: z.string().min(1),
}).passthrough()

export const UpdateMetadataBodySchema = z.object({
  account: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export const FetchItemsInputSchema = z.object({
  account: z.string().min(1),
  cacheTime: z.number().nullable().optional(),
  ids: z.array(z.string()).optional(),
})

export const ItemFormInputSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  description: z.string().max(500).optional().default(''),
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

export const PrayerCompletionBodySchema = z.object({
  account: z.string().min(1),
  completedAt: z.number(),
})