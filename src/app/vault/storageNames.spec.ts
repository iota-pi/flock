import { FLOCK_STORAGE_NAMES } from './storageNames'

describe('FLOCK_STORAGE_NAMES', () => {
  // Renaming any of these loses users' local documents, WAL or cached keyring
  it('never changes', () => {
    expect(FLOCK_STORAGE_NAMES).toEqual({
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
    })
  })
})
