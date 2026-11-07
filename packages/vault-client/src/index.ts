// Main-thread entry point: accounts, sessions and keys, the sync client and the app's configuration
// hooks. The sync worker's entry point is `@vault/client/worker`, and storage names are configured
// through `@vault/client/storageNames`.

export {
  changePassword,
  clearVaultDeviceData,
  createVaultAccount,
  exportData,
  getActiveKeyVersion,
  importData,
  loginVault,
  upgradeKeyDerivation,
} from './keys/vault'
export { lockVaultKeys } from './keys/session'
export { enableBiometrics, unlockWithBiometrics, StaleBiometricKeyError } from './keys/biometrics'
export {
  clearBiometricData,
  readBiometricData,
  hasBiometricData,
  subscribeBiometrics,
} from './keys/biometricStore'
export { isWebAuthnPrfSupported } from './keys/webauthn'
export { readStoredMetadata } from './keys/storedMetadata'
export { configureVaultHost, type VaultHostHooks } from './keys/vaultHost'
export type { KeyProvider } from './keys/Keyring'
export { createAccount, getSecurityParams } from './keys/AccountClient'
export type { VaultBroadcastEvent } from './keys/vaultEvents'
export {
  UnsupportedKeyDerivationError,
  type CryptoResult,
  type DeriveLegacyKey,
} from './keys/crypto'
export type { KdfParams } from './keys/kdf'
export { reencryptAllItems, resumePendingReencryption, type ReencryptionTarget } from './keys/reencrypt'
export { hasApiAuthToken } from './keys/runtime'
export { ApiHttpError, getTrackedFetch } from './keys/trackedFetch'
export { configureVaultEndpoint, createVaultLinks, initVaultTrpcClient } from './keys/vaultTrpcClient'

export { createSyncBridge, type SyncBridgeOptions, type SyncBridgeService } from './client/SyncBridge'
export type { SyncStateSink, SyncTelemetry } from './client/host'
export type {
  DataVersionStatus,
  MigrationRequiredReason,
  ReencryptCallOptions,
  ReencryptStage,
  SyncDiagnostics,
  SyncProgress,
  SyncStatus,
  UnsyncedChanges,
  VaultDoc,
  VaultMetadata,
} from './shared/types'
export { ReencryptionWaitError, reencryptionWaitStage } from './shared/reencryptionWaitError'
export { BackupSyncStateSchema, type BackupSyncState } from './shared/backupSyncState'
export type { ManualRecoveryEntry, ManualRecoveryKind } from './shared/manualRecoveryStore'
export { getOnlineState } from './utils/onlineStatus'
export { ensurePersistentStorage } from './utils/storageQuota'
export { fireAndForget } from './utils/fireAndForget'
