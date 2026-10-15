// Sync worker entry point: starts the engine and declares the hooks an app implements for it. Import
// it only from the app's worker, so the engine stays out of the main bundle.

export { exposeSyncWorker, type SyncWorkerConfig } from './sync/worker/sync.worker'
export * from './sync/worker/domain'
export { Keyring, type ExportedKeyring, type KeyProvider } from './api/Keyring'
export { MigrationRequiredError } from './sync/worker/DataVersionTracker'
export type { MigrationRequiredReason } from './sync/shared/types'

// Storage primitives for `SyncWorkerConfig.migrateLocalData`, which runs before the engine reads
// its stores
export { createAccountStore, getAccountDatabaseName } from './sync/shared/createAccountStore'
export { runStorageOperation } from './sync/utils/storageManager'
export { getSyncMetadataStorage, SYNC_METADATA_KEYS } from './sync/worker/stores/syncMetadataStorage'
export type { PersistedSyncCursors } from './sync/worker/stores/CursorStore'
export type { ItemSyncTimestamps } from './sync/worker/stores/LastModifiedStore'
