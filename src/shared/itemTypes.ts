import { z } from 'zod'
import type { CryptoResult } from 'src/api/vault'
import {
  ITEM_TYPES,
  ItemEnvelopeMetadataSchema,
  StandardItemEnvelopeSchema,
  TombstoneItemEnvelopeSchema,
  GroupLookupDataSchema,
} from './schemas/items'

export type ItemType = typeof ITEM_TYPES[number]

/**
 * Snapshot format: encrypted Automerge document (binary)
 */
export type VaultSnapshot = CryptoResult

export type ItemEnvelopeMetadata = z.infer<typeof ItemEnvelopeMetadataSchema>
export type StandardItemEnvelope = z.infer<typeof StandardItemEnvelopeSchema>
export type TombstoneItemEnvelope = z.infer<typeof TombstoneItemEnvelopeSchema>
export type GroupLookupData = z.infer<typeof GroupLookupDataSchema>

