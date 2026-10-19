import { FLOCK_STORAGE_NAMES } from './storageNames'

describe('FLOCK_STORAGE_NAMES', () => {
  // Renaming any of these loses users' local documents, WAL, cached keyring or settings
  it('never changes', () => {
    expect(FLOCK_STORAGE_NAMES).toEqual({
      vaultMetadataKey: 'FlockVaultMeta',
      keyringCacheKey: 'FlockKeyringCache',
      biometricDataKey: 'FlockBiometricData',
      autoLockSettingsKey: 'FlockAutoLockSettings',
      vaultEventsChannel: 'flock-vault-events',
      authDatabase: 'FlockVaultDB',
      webAuthnRpName: 'Flock',
      accountPrefixes: {
        automergeDatabase: 'flock-automerge-db-',
        sealedAutomergeDatabase: 'flock-automerge-sealed-',
        automergeBroadcastChannel: 'flock-automerge-broadcast-',
        indexChannel: 'flock-index-channel-',
        indexLock: 'flock-index-lock-',
        localDataMigrationLock: 'flock-local-data-migration-',
        syncPingChannel: 'flock-sync-ping-bus-',
        leaderPresenceChannel: 'flock-leader-presence-',
        leaderLock: 'flock-sync-leader-',
        syncMetadataDatabase: 'flock-sync-metadata-',
        walDatabase: 'FlockVault_SyncWAL_',
        sealedWalDatabase: 'FlockVault_SyncWAL_sealed_',
        manualRecoveryDatabase: 'FlockVault_ManualRecoveryDB_',
        accountStoreDatabase: 'FlockVault_',
      },
    })
  })
})
