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
  /**
   * The keyring's active key version. New accounts start at 2, so that an active version of 1 only
   * ever means a key that may be derived from a password. Older builds leave it out, which means 1.
   */
  keyringVersion: z.number().int().min(1).optional(),
})

export const AccountCreationResponseSchema = z.object({
  account: z.string(),
})

/** A device token is 32 random bytes as base64url (43 characters) */
export const DEVICE_TOKEN_LENGTH = 43

export const LoginBodySchema = z.object({
  account: z.string().min(1),
  authToken: z.string().min(1),
  /**
   * A random secret this device sends with every login. A device whose token the account has seen
   * with the right password can log in while the account is locked by failed logins.
   */
  deviceToken: z.string().length(DEVICE_TOKEN_LENGTH).optional(),
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
  /** The stored snapshot's encrypted heads, when the device that uploaded it sent them */
  heads?: z.infer<typeof CryptoResultSchema>
}

export const PutSnapshotResultItemSchema = z.object({
  itemId: ItemIdSchema,
  version: z.number().int().min(1),
})
export type PutSnapshotResultItem = z.infer<typeof PutSnapshotResultItemSchema>

export const FetchSnapshotsByIdsInputSchema = z.object({
  account: z.string().min(1),
  itemIds: z.array(ItemIdSchema).min(1).max(50),
  /**
   * Caps the response at about this many characters of ciphertext: the server returns items in the
   * requested order until the next would pass it (always at least one), and lists the rest in
   * `deferred` for the client to ask for again. Without it, every item comes back however large,
   * which can pass Lambda's response limit. Servers from before it ignore it.
   */
  maxResponseChars: z.number().int().min(1).optional(),
})

const SyncEncryptedMessageSchema = (
  CryptoResultSchema.extend({
    version: z.string().min(1).optional(),
  })
)

const SyncLogMessageSchema = z.object({
  itemId: ItemIdSchema,
  encryptedMessage: SyncEncryptedMessageSchema,
})
/** A message on its way to the account's log */
export type SyncLogMessage = z.infer<typeof SyncLogMessageSchema>

export const SyncLogEntrySchema = SyncLogMessageSchema.extend({
  seq: z.number().int().min(1),
  createdAt: z.number(),
})
/** A message in the account's log, at the position `seq` */
export type SyncLogEntry = z.infer<typeof SyncLogEntrySchema>

/** Appends `push` to the account's log and reads the log after the seq `after` */
export const PollLogSchema = z.object({
  account: z.string().min(1),
  push: z.array(SyncLogMessageSchema).max(100).default([]),
  after: z.number().int().min(0),
})

export const PutSnapshotBatchSchema = z.object({
  account: z.string().min(1),
  snapshots: z.array(VaultSnapshotSchema).min(1).max(25),
})
