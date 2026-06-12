import { z } from 'zod'
import { ItemIdSchema, ItemEnvelopeMetadataSchema } from 'src/shared/schemas/items'

export const LegacyItemEnvelopeSchema = z.object({
  item: ItemIdSchema,
  cipher: z.string(),
  snapshot: z.undefined().optional(),
  metadata: ItemEnvelopeMetadataSchema,
})

export type LegacyItemEnvelope = z.infer<typeof LegacyItemEnvelopeSchema>

