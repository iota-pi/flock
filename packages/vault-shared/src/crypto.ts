import { z } from 'zod'

/**
 * Ciphertext format bound to the document it belongs to: the doc ID is AES-GCM associated data,
 * so a ciphertext only decrypts as the doc it was written for. Ciphertexts without a format
 * predate binding.
 */
export const DOC_BOUND_FORMAT = 2

export const CryptoResultSchema = z.object({
  iv: z.string().min(1),
  cipher: z.string().min(1),
  kver: z.string().optional(),
  format: z.literal(DOC_BOUND_FORMAT).optional(),
})
