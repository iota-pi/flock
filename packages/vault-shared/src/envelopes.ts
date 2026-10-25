import { z } from 'zod'
import { CryptoResultSchema } from './crypto'
import { ItemIdSchema } from './ids'

export const ItemEnvelopeMetadataSchema = z.object({
  /** Only legacy items use it. The server writes `''` with snapshots. */
  iv: z.string().optional(),
  modified: z.number(),
  deleted: z.boolean().optional(),
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
  metadata: ItemEnvelopeMetadataSchema.extend({
    iv: z.string(),
  }),
})

/** An item row as `fetchSnapshotsByIds` returns it: one of the envelope shapes, with its server-assigned version */
export type FetchedItem = (
  | z.infer<typeof StandardItemEnvelopeSchema>
  | z.infer<typeof TombstoneItemEnvelopeSchema>
  | z.infer<typeof LegacyItemEnvelopeSchema>
) & { version?: number }
