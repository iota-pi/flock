import type { ItemId } from '@vault/shared/ids'

/**
 * A synced document as the vault sees it. Apps describe their own document shape with a DocCodec;
 * the vault itself only relies on `id` and the `deleted` tombstone flag.
 */
export type VaultDoc = {
  id: ItemId
  deleted?: boolean
  [key: string]: unknown
}

/** Account-level settings stored with the local item index */
export type VaultMetadata = Record<string, unknown>

export type SyncStatus = 'idle' | 'connecting' | 'syncing' | 'offline' | 'degraded' | 'dead'
