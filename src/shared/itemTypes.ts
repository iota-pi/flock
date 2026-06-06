import type { CryptoResult } from 'src/api/vault'
import { ITEM_TYPES, ItemId } from './schemas/items'

export type ItemType = typeof ITEM_TYPES[number]

/**
 * Snapshot format: encrypted Automerge document (binary)
 */
export type VaultSnapshot = CryptoResult

export type ItemEnvelopeMetadata = {
  type: ItemType,
  iv: string,
  modified: number,
  deleted?: boolean,
  compactedAt?: number,
}

export type StandardItemEnvelope = {
  item: ItemId,
  cipher?: undefined,
  snapshot: VaultSnapshot,
  metadata: ItemEnvelopeMetadata,
}

export type TombstoneItemEnvelope = {
  item: ItemId,
  cipher?: undefined,
  snapshot?: undefined,
  metadata: ItemEnvelopeMetadata & {
    deleted: true,
  },
}

export interface GroupLookupData {
  groupNames: string[]
  groupIds: ItemId[]
}
