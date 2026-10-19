import { z } from 'zod'

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

export const CryptoResultSchema = z.object({
  iv: z.string().min(1),
  cipher: z.string().min(1),
  kver: z.string().optional(),
  format: z.literal(DOC_BOUND_FORMAT).optional(),
})
