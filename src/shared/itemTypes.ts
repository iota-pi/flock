export const ITEM_TYPES = ['person', 'group', 'topic'] as const
export const ERROR_ITEM_TYPE = 'error'

export type ItemType = typeof ITEM_TYPES[number]
export type ItemId = string

/**
 * Branching Format: New CRDT-based storage format
 * - doc: Uint8Array serialized Automerge document (binary)
 * - versionId: Unique identifier for this specific version
 * - parentIds: Array of parent version IDs (enables lineage tracking & conflict detection)
 */
export type VaultBranch = {
  doc: string, // Base64-encoded Uint8Array
  versionId: string,
  parentIds: string[],
}

type VaultBranchList = [VaultBranch, ...VaultBranch[]]

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
  branches: VaultBranchList,
  metadata: ItemEnvelopeMetadata,
}

export type TombstoneItemEnvelope = {
  item: ItemId,
  cipher?: undefined,
  branches?: undefined,
  metadata: ItemEnvelopeMetadata & {
    deleted: true,
  },
}

export interface GroupLookupData {
  groupNames: string[]
  groupIds: ItemId[]
}
