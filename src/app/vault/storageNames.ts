import type { VaultStorageNames } from '@vault/client/sync/shared/storageNames'

/** The names Flock has always used. Changing any of them orphans existing users' local data. */
export const FLOCK_STORAGE_NAMES: VaultStorageNames = {
  vaultMetadataKey: 'FlockVaultMeta',
  keyringCacheKey: 'FlockKeyringCache',
  biometricDataKey: 'FlockBiometricData',
  autoLockSettingsKey: 'FlockAutoLockSettings',
  vaultEventsChannel: 'flock-vault-events',
  authDatabase: 'FlockVaultDB',
  webAuthnRpName: 'Flock',
  accountPrefixes: {
    automergeDatabase: 'flock-automerge-db-',
    automergeBroadcastChannel: 'flock-automerge-broadcast-',
    indexChannel: 'flock-index-channel-',
    indexLock: 'flock-index-lock-',
    localDataMigrationLock: 'flock-local-data-migration-',
    syncPingChannel: 'flock-sync-ping-bus-',
    leaderPresenceChannel: 'flock-leader-presence-',
    leaderLock: 'flock-sync-leader-',
    syncMetadataDatabase: 'flock-sync-metadata-',
    walDatabase: 'FlockVault_SyncWAL_',
    manualRecoveryDatabase: 'FlockVault_ManualRecoveryDB_',
    accountStoreDatabase: 'FlockVault_',
  },
}
