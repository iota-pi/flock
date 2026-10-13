import { z } from 'zod'
import { CryptoResultSchema } from './crypto'
import { VaultSnapshotSchema } from './snapshots'
import { ItemIdSchema, type ItemId } from './items'


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
  keyringVersion: z.number().int().min(1).optional(),
  expectedKeyringVersion: z.number().int().min(1).optional(),
})

export const ChangePasswordBodySchema = z.object({
  account: z.string().min(1),
  currentAuthToken: z.string().min(1),
  newAuthToken: z.string().min(1),
  newSalt: z.string().min(1),
  newIterations: z.number().int().min(1),
  newKeyring: z.string().min(1),
  saltVersion: z.number().int().min(1).optional(),
  keyringVersion: z.number().int().min(1).optional(),
  expectedKeyringVersion: z.number().int().min(1).optional(),
})

export const FetchItemsInputSchema = z.object({
  account: z.string().min(1),
})

export type ManifestEntry = {
  itemId: ItemId
  version?: number
  modifiedAt?: number
  isDeleted?: boolean
}

export const PutSnapshotResultItemSchema = z.object({
  itemId: ItemIdSchema,
  version: z.number().int().min(1),
})
export type PutSnapshotResultItem = z.infer<typeof PutSnapshotResultItemSchema>

export const FetchSnapshotsByIdsInputSchema = z.object({
  account: z.string().min(1),
  itemIds: z.array(ItemIdSchema).min(1).max(50),
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
  })).min(1).max(1000),
})

export const SyncMessageLastEvaluatedKeySchema = z.object({
  syncId: z.string().min(1),
  cursor: z.number().int().min(0),
}).strict()
export type SyncMessageLastEvaluatedKey = z.infer<typeof SyncMessageLastEvaluatedKeySchema>

export const GlobalSyncLastEvaluatedKeySchema = z.object({
  account: z.string().min(1),
  cursor: z.number().int().min(0),
  syncId: z.string().min(1),
}).strict()
export type GlobalSyncLastEvaluatedKey = z.infer<typeof GlobalSyncLastEvaluatedKeySchema>

export const SyncPollBatchSchema = z.object({
  account: z.string().min(1),
  clientLatestCursor: z.number().int().min(0).optional(),
  globalLastEvaluatedKey: GlobalSyncLastEvaluatedKeySchema.optional(),
  pushMessages: z.array(z.object({
    itemId: ItemIdSchema,
    encryptedMessage: SyncEncryptedMessageSchema,
  })).max(100).default([]),
  pullCursors: z.array(z.object({
    itemId: ItemIdSchema,
    cursor: z.number().int().min(0).optional(),
    lastEvaluatedKey: SyncMessageLastEvaluatedKeySchema.optional(),
  })).max(100).default([]),
})

export const PutSnapshotBatchSchema = z.object({
  account: z.string().min(1),
  snapshots: z.array(VaultSnapshotSchema).min(1).max(25),
})
