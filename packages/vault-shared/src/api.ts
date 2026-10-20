import { z } from 'zod'
import { CryptoResultSchema, KdfParamsSchema } from './crypto'
import { VaultSnapshotSchema } from './snapshots'
import { ItemIdSchema, type ItemId } from './ids'

// New credentials always use Argon2id and a random data key. Accounts still on PBKDF2 can log in
// with what they have, but nothing creates PBKDF2 credentials any more.
export const CreateAccountBodySchema = z.object({
  salt: z.string().min(1),
  authToken: z.string().min(1),
  saltVersion: z.number().int().min(1).optional(),
  kdf: KdfParamsSchema,
  /** The account's keyring, encrypted with the master key */
  keyring: z.string().min(1),
  /** Every data key in `keyring` was generated randomly, rather than derived from the password */
  randomDataKeys: z.literal(true),
})

export const AccountCreationResponseSchema = z.object({
  account: z.string(),
})

export const LoginBodySchema = z.object({
  account: z.string().min(1),
  authToken: z.string().min(1),
})

export const AccountInputSchema = z.looseObject({
  account: z.string().min(1),
})

export const UpdateKeyringBodySchema = z.object({
  account: z.string().min(1),
  /** Proves the caller holds the master key, so a session token alone can't replace the keyring */
  currentAuthToken: z.string().min(1),
  keyring: z.string().min(1),
  keyringVersion: z.number().int().min(1).optional(),
  expectedKeyringVersion: z.number().int().min(1).optional(),
})

export const ChangePasswordBodySchema = z.object({
  account: z.string().min(1),
  currentAuthToken: z.string().min(1),
  newAuthToken: z.string().min(1),
  newSalt: z.string().min(1),
  newKdf: KdfParamsSchema,
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

const SyncEncryptedMessageSchema = (
  CryptoResultSchema.extend({
    version: z.string().min(1).optional(),
  })
)

/**
 * Continues a paginated pull where the previous page stopped. Only the driver that issued it
 * knows what it contains; clients pass it back unchanged.
 */
export const PageTokenSchema = z.string().min(1).max(2048)
export type PageToken = z.infer<typeof PageTokenSchema>

export const SyncPollBatchSchema = z.object({
  account: z.string().min(1),
  clientLatestCursor: z.number().int().min(0).optional(),
  globalPageToken: PageTokenSchema.optional(),
  pushMessages: z.array(z.object({
    itemId: ItemIdSchema,
    encryptedMessage: SyncEncryptedMessageSchema,
  })).max(100).default([]),
  pullCursors: z.array(z.object({
    itemId: ItemIdSchema,
    cursor: z.number().int().min(0).optional(),
    pageToken: PageTokenSchema.optional(),
  })).max(100).default([]),
})

export const PutSnapshotBatchSchema = z.object({
  account: z.string().min(1),
  snapshots: z.array(VaultSnapshotSchema).min(1).max(25),
})
