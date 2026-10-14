import { z } from 'zod'

export const VaultKeySchema = z.object({
  account: z.string(),
  item: z.string(),
})

const VaultMetaDataSchema = z.object({
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
  sessions: z.array(VaultSessionRecordSchema).optional(),
  authToken: z.string(),
  salt: z.string(),
  iterations: z.number(),
  keyring: z.string().optional(),
  keyringVersion: z.number().optional(),
  saltVersion: z.number().optional(),
})

export const VaultAccountWithAuthSchema = VaultAccountSchema.extend({
  session: z.string(),
})

const VaultItemSnapshotSchema = z.object({
  iv: z.string(),
  cipher: z.union([z.string(), z.instanceof(Uint8Array), z.any()]).optional(),
  kver: z.string().optional(),
})

export const VaultItemSchema = VaultKeySchema.extend({
  metadata: VaultMetaDataSchema,
  cipher: z.string().optional(),
  snapshot: VaultItemSnapshotSchema.optional(),
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
