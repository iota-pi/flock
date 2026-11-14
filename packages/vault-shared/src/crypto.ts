import { z } from 'zod'
import { MAX_CIPHER_FIELD_LENGTH } from './limits'

/**
 * Ciphertext format bound to the document it belongs to: the doc ID is AES-GCM associated data,
 * so a ciphertext only decrypts as the doc it was written for. Ciphertexts without a format
 * predate binding.
 */
export const DOC_BOUND_FORMAT = 2

/**
 * Argon2id parameters for deriving an account's master key from its password. Clients choose them
 * and the server only stores them, so this checks their shape. Clients enforce their own minimum
 * on what they read back.
 */
export const KdfParamsSchema = z.object({
  algorithm: z.literal('argon2id'),
  memoryKiB: z.number().int().min(1).max(4 * 1024 * 1024),
  passes: z.number().int().min(1).max(1000),
  parallelism: z.number().int().min(1).max(255),
})
export type KdfParams = z.infer<typeof KdfParamsSchema>

/**
 * The cipher itself has no cap here: the server checks snapshots against MAX_ITEM_SIZE, and
 * DynamoDB's item limit bounds log rows.
 */
export const CryptoResultSchema = z.object({
  iv: z.string().min(1).max(MAX_CIPHER_FIELD_LENGTH),
  cipher: z.string().min(1),
  kver: z.string().max(MAX_CIPHER_FIELD_LENGTH).optional(),
  format: z.literal(DOC_BOUND_FORMAT).optional(),
})
