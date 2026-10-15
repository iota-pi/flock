import { z } from 'zod'
import type { LegacyItemContext, LegacyItemEnvelope, RawDoc } from '@vault/client/sync/worker/domain'

/** The parts of a pre-Automerge item row needed to decrypt it */
const LegacyCipherRowSchema = z.object({
  cipher: z.string().min(1),
  metadata: z.object({
    iv: z.string().min(1),
    kver: z.string().optional(),
  }),
})

/**
 * Decodes items Flock stored before Automerge, as a single encrypted JSON blob in the row's `cipher`
 * field (stage 2.5e in docs/vault-extraction.md). The engine stores the result as a new document
 * and uploads it as a snapshot, after which the server drops `cipher`.
 */
export async function decodeLegacyCipherItem(
  item: LegacyItemEnvelope,
  context: LegacyItemContext,
): Promise<RawDoc | null> {
  const parsed = LegacyCipherRowSchema.safeParse(item)
  if (!parsed.success) return null

  const { cipher, metadata: { iv, kver } } = parsed.data
  if (kver) {
    await context.ensureKey(kver)
  }

  const plaintext = await context.decrypt({ iv, cipher, kver })
  const decoded: unknown = JSON.parse(new TextDecoder().decode(plaintext))
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    return null
  }
  return decoded as RawDoc
}
