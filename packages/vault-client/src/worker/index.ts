// Sync worker entry point: starts the engine and declares the hooks an app implements for it. Import
// it only from the app's worker, so the engine stays out of the main bundle.

export { exposeSyncWorker, type SyncWorkerConfig } from './sync.worker'
export * from './domain'
export type { ExportedKeyring, KeyProvider } from '../keys/Keyring'
export type { MigrationRequiredReason } from '../shared/types'

// Storage primitives for `SyncWorkerConfig.migrateLocalData`, which runs before the engine reads
// its stores
export { createAccountStore, getAccountDatabaseName } from '../shared/createAccountStore'
export { runStorageOperation } from '../utils/storageManager'
export { databaseExists } from '../utils/databaseExists'
export { getSyncMetadataStorage, SYNC_METADATA_KEYS } from './stores/syncMetadataStorage'
export type { PersistedSyncCursors } from './stores/CursorStore'
export type { ItemSyncTimestamps } from './stores/LastModifiedStore'
