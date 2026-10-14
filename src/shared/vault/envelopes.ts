import { z } from 'zod'
import { CryptoResultSchema } from './crypto'
import { ItemIdSchema } from './ids'

export const ItemEnvelopeMetadataSchema = z.object({
  iv: z.string(),
  modified: z.number(),
  deleted: z.boolean().optional(),
  compactedAt: z.number().optional(),
})

export const StandardItemEnvelopeSchema = z.object({
  item: ItemIdSchema,
  cipher: z.undefined().optional(),
  snapshot: CryptoResultSchema.optional(),
  metadata: ItemEnvelopeMetadataSchema,
})

export const TombstoneItemEnvelopeSchema = z.object({
  item: ItemIdSchema,
  cipher: z.undefined().optional(),
  snapshot: z.undefined().optional(),
  metadata: ItemEnvelopeMetadataSchema.extend({
    deleted: z.literal(true),
  }),
})

/** Items stored before Automerge, as a single encrypted JSON blob. */
export const LegacyItemEnvelopeSchema = z.object({
  item: ItemIdSchema,
  cipher: z.string(),
  snapshot: z.undefined().optional(),
  metadata: ItemEnvelopeMetadataSchema,
})
