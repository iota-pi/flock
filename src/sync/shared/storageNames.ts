/**
 * Names of the browser storage the vault uses. They must stay stable across releases: renaming
 * one orphans the data already stored under the old name.
 */
export interface VaultStorageNames {
  /** localStorage key for the account id and key derivation parameters */
  vaultMetadataKey: string
  /** localStorage key for the encrypted keyring cache */
  keyringCacheKey: string
  /** localStorage key for biometric unlock data */
  biometricDataKey: string
  /** localStorage key for auto-lock settings */
  autoLockSettingsKey: string
  /** BroadcastChannel for key rotation and password change events */
  vaultEventsChannel: string
  /** localforage database holding the session token shared with the sync worker */
  authDatabase: string
  /** Relying party name shown in WebAuthn prompts */
  webAuthnRpName: string
  /** Prefixes for per-account resources. The account id is appended to each. */
  accountPrefixes: {
    automergeDatabase: string
    automergeBroadcastChannel: string
    indexChannel: string
    indexLock: string
    /** Web Lock held while the app's `migrateLocalData` hook runs, so tabs migrate one at a time */
    localDataMigrationLock: string
    syncPingChannel: string
    leaderPresenceChannel: string
    leaderLock: string
    syncMetadataDatabase: string
    walDatabase: string
    manualRecoveryDatabase: string
    /** Fallback for other account stores, as `${prefix}${storeName}_${accountId}` */
    accountStoreDatabase: string
  }
}

// Held on globalThis because the names belong to the realm, even if this module is loaded more than once
const STORAGE_NAMES_KEY = Symbol.for('vault.storageNames')

type GlobalWithStorageNames = typeof globalThis & { [STORAGE_NAMES_KEY]?: VaultStorageNames }

/** Sets the storage names. Call once at startup in every realm (main thread and sync worker). */
export function configureVaultStorageNames(names: VaultStorageNames): void {
  (globalThis as GlobalWithStorageNames)[STORAGE_NAMES_KEY] = names
}

export function getVaultStorageNames(): VaultStorageNames {
  const names = (globalThis as GlobalWithStorageNames)[STORAGE_NAMES_KEY]
  if (!names) {
    throw new Error('Vault storage names are not configured. Call configureVaultStorageNames at startup.')
  }
  return names
}

/** A consistent naming scheme for new apps */
export function createVaultStorageNames(appName: string): VaultStorageNames {
  const prefix = `${appName}-vault`
  return {
    vaultMetadataKey: `${prefix}-meta`,
    keyringCacheKey: `${prefix}-keyring-cache`,
    biometricDataKey: `${prefix}-biometrics`,
    autoLockSettingsKey: `${prefix}-auto-lock`,
    vaultEventsChannel: `${prefix}-events`,
    authDatabase: `${prefix}-auth`,
    webAuthnRpName: appName,
    accountPrefixes: {
      automergeDatabase: `${prefix}-automerge-`,
      automergeBroadcastChannel: `${prefix}-automerge-broadcast-`,
      indexChannel: `${prefix}-index-channel-`,
      indexLock: `${prefix}-index-lock-`,
      localDataMigrationLock: `${prefix}-local-data-migration-`,
      syncPingChannel: `${prefix}-sync-ping-`,
      leaderPresenceChannel: `${prefix}-leader-presence-`,
      leaderLock: `${prefix}-leader-`,
      syncMetadataDatabase: `${prefix}-sync-metadata-`,
      walDatabase: `${prefix}-wal-`,
      manualRecoveryDatabase: `${prefix}-manual-recovery-`,
      accountStoreDatabase: `${prefix}-store-`,
    },
  }
}
