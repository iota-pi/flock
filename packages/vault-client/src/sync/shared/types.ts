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
