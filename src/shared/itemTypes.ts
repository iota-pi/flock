export const ITEM_TYPES = ['person', 'group', 'topic'] as const

export type ItemType = typeof ITEM_TYPES[number]
export type ItemId = string

/**
 * Branching Format: New CRDT-based storage format
 * - encryptedAutomergeDoc: Uint8Array serialized Automerge document (binary)
 * - versionId: Unique identifier for this specific version
 * - parentIds: Array of parent version IDs (enables lineage tracking & conflict detection)
 */
export type VaultBranch = {
  encryptedAutomergeDoc: string, // Base64-encoded Uint8Array
  versionId: string,
  parentIds: string[],
}

/**
 * ItemEnvelope: Dual-format container supporting legacy and new branching formats
 * - Legacy: Has `cipher` string, no `branches`
 * - Single Branch: Has `branches` array with 1 item
 * - Multiple Branches (Conflict): Has `branches` array with 2+ items
 */
export type ItemEnvelope = {
  item: ItemId, // item ID
  cipher?: string, // Legacy format only
  branches?: VaultBranch[], // New branching format
  metadata: {
    type: ItemType,
    iv: string, // For legacy cipher decryption
    modified: number,
    deleted?: boolean,
    compactedAt?: number,
  },
}
