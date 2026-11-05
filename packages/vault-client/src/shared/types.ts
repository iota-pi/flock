import type { ItemId } from '@vault/shared'

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

/** Local changes on this device that the server doesn't have yet, which clearing local data would lose */
export interface UnsyncedChanges {
  /** Items with changes not yet pushed or a snapshot not yet uploaded */
  pendingItems: number
  /** Items held for manual recovery, whose local changes aren't syncing (not counted in `pendingItems`) */
  quarantinedItems: number
}

/** How far this device's changes have reached the server, as the worker's `syncProgress` events report it */
export interface SyncProgress extends UnsyncedChanges {
  /** When any of the account's tabs on this device last completed a sync with the server, or null if none has */
  lastSyncedAt: number | null
}

/**
 * Why sync can't run until the app's migration app has run (see `SyncWorkerConfig.minDataVersion`):
 * this device's local data is below the minimum level, or the server holds rows in a legacy format.
 */
export type MigrationRequiredReason = 'device' | 'account'

/** How far migration has got, as reported by `SyncApi.checkDataVersion` */
export interface DataVersionStatus {
  /** The level this device's local data has been migrated to */
  device: number
  /** The account's level, as the server reports it after checking the account's data */
  account: number
  /** What still holds the account below the app's current level */
  blockers: string[]
}

/** The items re-encrypted under the active data key, and those that couldn't be */
export interface ReencryptResult {
  succeeded: ItemId[]
  failed: Array<{ itemId: ItemId; error: string }>
}
