import { z } from 'zod'
import { CryptoResultSchema } from './crypto'
import { VaultSnapshotSchema } from './snapshots'
import { ItemIdSchema } from './items'


const WebPushSubscriptionKeysSchema = z.object({
  p256dh: z.string(),
  auth: z.string(),
})

export const CreateAccountBodySchema = z.object({
  salt: z.string().min(1),
  authToken: z.string().min(1),
  iterations: z.number().int().min(1),
  saltVersion: z.number().int().min(1).optional(),
})

export const AccountCreationResponseSchema = z.object({
  account: z.string(),
})

export const ReminderSettingsResponseSchema = z.object({
  success: z.boolean(),
  reminderEnabled: z.boolean(),
  reminderTime: z.string(),
  reminderTimezone: z.string(),
})

export const LoginBodySchema = z.object({
  account: z.string().min(1),
  authToken: z.string().min(1),
})

export const AccountInputSchema = z.looseObject({
  account: z.string().min(1),
})

export const UpdateMetadataBodySchema = z.object({
  account: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export const UpdateKeyringBodySchema = z.object({
  account: z.string().min(1),
  keyring: z.string().min(1),
})

export const ChangePasswordBodySchema = z.object({
  account: z.string().min(1),
  currentAuthToken: z.string().min(1),
  newAuthToken: z.string().min(1),
  newSalt: z.string().min(1),
  newIterations: z.number().int().min(1),
  newKeyring: z.string().min(1),
  saltVersion: z.number().int().min(1).optional(),
})

export const FetchItemsInputSchema = z.object({
  account: z.string().min(1),
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

const SyncEncryptedMessageSchema = (
  CryptoResultSchema.extend({
    version: z.string().min(1).optional(),
  })
)

export const SyncPushBatchSchema = z.object({
  account: z.string().min(1),
  messages: z.array(z.object({
    itemId: ItemIdSchema,
    encryptedMessage: SyncEncryptedMessageSchema,
  })).min(1),
})

export const SyncPollBatchSchema = z.object({
  account: z.string().min(1),
  pushMessages: z.array(z.object({
    itemId: ItemIdSchema,
    encryptedMessage: SyncEncryptedMessageSchema,
  })).default([]),
  pullCursors: z.array(z.object({
    itemId: ItemIdSchema,
    cursor: z.number().int().min(0).optional(),
  })).default([]),
})

export const PutSnapshotBatchSchema = z.object({
  account: z.string().min(1),
  snapshots: z.array(VaultSnapshotSchema).min(1).max(25),
})
