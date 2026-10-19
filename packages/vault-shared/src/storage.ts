import { z } from 'zod'
import { DOC_BOUND_FORMAT, KdfParamsSchema } from './crypto'

export const VaultKeySchema = z.object({
  account: z.string(),
  item: z.string(),
})

const VaultMetaDataSchema = z.object({
  iv: z.string(),
  modified: z.number(),
  deleted: z.boolean().optional(),
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
  /** PBKDF2 iterations, for accounts without `kdf` */
  iterations: z.number().optional(),
  /** Argon2id parameters. Accounts without them derive their key with PBKDF2. */
  kdf: KdfParamsSchema.optional(),
  /** Every data key was generated randomly, so none is derived from a password (set when the account is created) */
  randomDataKeys: z.boolean().optional(),
  keyring: z.string().optional(),
  keyringVersion: z.number().optional(),
  saltVersion: z.number().optional(),
  /** The app's data version this account's stored data has been migrated to (see DataVersionPolicy) */
  dataVersion: z.number().optional(),
  /** When the account last logged in or renewed a session */
  lastAccess: z.number().optional(),
})

export const VaultAccountWithAuthSchema = VaultAccountSchema.extend({
  session: z.string(),
})

const VaultItemSnapshotSchema = z.object({
  iv: z.string(),
  cipher: z.union([z.string(), z.instanceof(Uint8Array), z.any()]).optional(),
  kver: z.string().optional(),
  format: z.literal(DOC_BOUND_FORMAT).optional(),
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
    kver: z.string().optional(),
    format: z.literal(DOC_BOUND_FORMAT).optional(),
    version: z.string().optional(),
  }),
  createdAt: z.number(),
})
