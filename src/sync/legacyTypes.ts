import type { ItemEnvelopeMetadata, ItemId } from '../shared/itemTypes'

export type LegacyItemEnvelope = {
  item: ItemId,
  cipher: string,
  branches?: undefined,
  metadata: ItemEnvelopeMetadata,
}
