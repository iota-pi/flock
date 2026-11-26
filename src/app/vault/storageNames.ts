import type { VaultStorageNames } from '@vault/client/storageNames'

/** The names Flock has always used. Changing any of them orphans existing users' local data. */
export const FLOCK_STORAGE_NAMES: VaultStorageNames = {
  vaultMetadataKey: 'FlockVaultMeta',
  keyringCacheKey: 'FlockKeyringCache',
  biometricDataKey: 'FlockBiometricData',
  loginDeviceKey: 'FlockLoginDevice',
  vaultEventsChannel: 'flock-vault-events',
  authDatabase: 'FlockVaultDB',
  webAuthnRpName: 'Flock',
  accountPrefixes: {
    automergeDatabase: 'flock-automerge-db-',
    sealedAutomergeDatabase: 'flock-automerge-sealed-',
    indexLock: 'flock-index-lock-',
    localDataMigrationLock: 'flock-local-data-migration-',
    leaderLock: 'flock-sync-leader-',
    syncMetadataDatabase: 'flock-sync-metadata-',
    walDatabase: 'FlockVault_SyncWAL_',
    sealedWalDatabase: 'FlockVault_SyncWAL_sealed_',
    manualRecoveryDatabase: 'FlockVault_ManualRecoveryDB_',
    syncLogDatabase: 'flock-sync-log-',
    accountStoreDatabase: 'FlockVault_',
  },
}
