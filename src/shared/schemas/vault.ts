import { z } from 'zod'
import { CryptoResultSchema } from './crypto'

export const WebPushSubscriptionSchema = z.object({
  endpoint: z.string(),
  keys: z.object({
    p256dh: z.string(),
    auth: z.string(),
  }),
})

export const VaultKeySchema = z.object({
  account: z.string(),
  item: z.string(),
})

export const VaultMetaDataSchema = z.object({
  type: z.enum(['person', 'group', 'topic']),
  iv: z.string(),
  modified: z.number(),
  deleted: z.boolean().optional(),
  compactedAt: z.number().optional(),
})

export const VaultSessionRecordSchema = z.object({
  token: z.string(),
  expiry: z.number(),
})

export const VaultAccountSchema = z.object({
  account: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  sessions: z.array(VaultSessionRecordSchema).optional(),
  pushSubscriptions: z.array(WebPushSubscriptionSchema).optional(),
  reminderEnabled: z.boolean().optional(),
  reminderTime: z.string().optional(),
  reminderTimezone: z.string().optional(),
  lastPrayerCompletedAt: z.number().optional(),
  lastSnapshotCursor: z.number().optional(),
  lastSnapshotAt: z.number().optional(),
  lastSnapshotRequestedAt: z.number().optional(),
  latestSyncCursor: z.number().optional(),
  authToken: z.string(),
  salt: z.string(),
  iterations: z.number(),
  keyring: z.string().optional(),
  saltVersion: z.number().optional(),
})

export const VaultAccountWithAuthSchema = VaultAccountSchema.extend({
  session: z.string(),
})

export const VaultItemSchema = VaultKeySchema.extend({
  metadata: VaultMetaDataSchema,
  cipher: z.string().optional(),
  snapshot: CryptoResultSchema.optional(),
  ttl: z.number().optional(),
  version: z.number().optional(),
})

export const StoredSyncMessageSchema = z.object({
  cursor: z.number(),
  encryptedMessage: z.object({
    iv: z.string(),
    cipher: z.string(),
    version: z.string().optional(),
  }),
  createdAt: z.number(),
})
