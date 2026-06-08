import type { ItemEnvelopeMetadata } from '../../shared/itemTypes'
import { ItemId } from 'src/shared/schemas/items'

export type LegacyItemEnvelope = {
  item: ItemId,
  cipher: string,
  snapshot?: undefined,
  metadata: ItemEnvelopeMetadata,
}
