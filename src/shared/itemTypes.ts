import type { CryptoResult } from 'src/api/vault'

export const ITEM_TYPES = ['person', 'group', 'topic'] as const
export const ERROR_ITEM_TYPE = 'error'

export type ItemType = typeof ITEM_TYPES[number]
export type ItemId = string

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
