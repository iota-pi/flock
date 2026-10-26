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
} from './api/vault'
export {
  establishSessionFromKeyHash,
  getKeyHash,
  getVaultSession,
  handleSessionExpired,
  lockVaultKeys,
  onLateSession,
} from './api/session'
export { enableBiometrics, unlockWithBiometrics, StaleBiometricKeyError } from './api/biometrics'
export {
  clearBiometricData,
  readBiometricData,
  hasBiometricData,
  subscribeBiometrics,
} from './api/biometricStore'
export { isWebAuthnPrfSupported } from './api/webauthn'
export { readStoredMetadata, hasRandomDataKeys } from './api/storedMetadata'
export { configureVaultHost, type VaultHostHooks } from './api/vaultHost'
export { VaultNotInitializedError, type KeyProvider } from './api/Keyring'
export { createAccount, getSecurityParams } from './api/AccountClient'
export type { VaultBroadcastEvent } from './api/vaultEvents'
export {
  generateSalt,
  generateVaultKey,
  UnsupportedKeyDerivationError,
  type CryptoResult,
  type DeriveLegacyKey,
} from './api/crypto'
export { enableTestKeyDerivation, getDefaultKdf, type KdfParams } from './api/kdf'
export {
  type AutoLockMode,
  type AutoLockSettings,
  DEFAULT_AUTO_LOCK_SETTINGS,
  INACTIVITY_PRESETS,
  clearAutoLockSettings,
  getAutoLockSummary,
  readAutoLockSettings,
  writeAutoLockSettings,
} from './api/autoLockStore'
export { reencryptAllItems, resumePendingReencryption, type ReencryptionTarget } from './api/reencrypt'
export { assertSuccess } from './api/clientUtils'
export { hasApiAuthToken, setApiAuthToken } from './api/runtime'
export { ApiHttpError, getTrackedFetch } from './api/trackedFetch'
export { configureVaultEndpoint, createVaultLinks, initVaultTrpcClient } from './api/vaultTrpcClient'

export { createSyncBridge, type SyncBridgeOptions, type SyncBridgeService } from './sync/client/SyncBridge'
export { noopTelemetry, type SyncStateSink, type SyncTelemetry } from './sync/client/host'
export type {
  DataVersionStatus,
  MigrationRequiredReason,
  SyncStatus,
  VaultDoc,
  VaultMetadata,
} from './sync/shared/types'
export { BackupSyncStateSchema, type BackupSyncState } from './sync/shared/backupSyncState'
export type { ManualRecoveryEntry, ManualRecoveryKind } from './sync/shared/manualRecoveryStore'
export { getOnlineState } from './sync/utils/onlineStatus'
export { ensurePersistentStorage } from './sync/utils/storageQuota'
export { fireAndForget } from './sync/utils/fireAndForget'
export { createLogger, type Logger } from './sync/utils/logger'
