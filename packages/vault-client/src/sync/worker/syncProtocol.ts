import type { DataVersionStatus, VaultDoc, VaultMetadata } from '../shared/types'
import type { ManualRecoveryEntry, ReadManualRecoveryOptions } from '../shared/manualRecoveryStore'
import type { BackupSyncState } from '../shared/backupSyncState'
import { ItemId } from '@vault/shared'

export interface InitRepoOptions {
  /** Whether the account's data keys are random, so an active key version of '1' may seal local data */
  randomDataKeys?: boolean
  /** The main thread's session token, which the worker keeps only in memory */
  authToken?: string | null
}

/** How many of the snapshots a push tried to upload the server persisted */
export interface SnapshotPushResult {
  persisted: number
  total: number
}

/** Whether saving the items that failed to save locally (e.g. over quota) succeeded this time */
export interface RetrySaveResult {
  success: boolean
  error?: string
}

/** The items re-encrypted under the active data key, and those that couldn't be */
export interface ReencryptResult {
  succeeded: ItemId[]
  failed: Array<{ itemId: ItemId; error: string }>
}

/**
 * The sync worker's Comlink API. `TDoc` and `TMeta` are the app's document and metadata types,
 * as produced by its DocCodec.
 */
export interface SyncApi<TDoc extends VaultDoc = VaultDoc, TMeta extends VaultMetadata = VaultMetadata> {
  initRepo: (
    accountId: string,
    vaultKey: string,
    options?: InitRepoOptions,
  ) => Promise<void>
  setOnlineState: (isOnline: boolean) => Promise<void>
  bootstrapItems: () => Promise<void>
  mutateItem: (id: ItemId, changes: Partial<TDoc>) => Promise<void>
  createItem: (item: TDoc) => Promise<void>
  storeItems: (items: TDoc[]) => Promise<void>
  mutateMetadata: (changes: Partial<TMeta>) => Promise<void>
  exportAllBinaries: () => Promise<{ documents: Partial<Record<string, string>>; skipped: string[] }>
  restoreFromBinaries: (documents: Partial<Record<string, string>>) => Promise<string[]>
  flushSync: () => Promise<void>
  fullResync: () => Promise<boolean>
  pushSnapshots: () => Promise<SnapshotPushResult>
  retrySave: () => Promise<RetrySaveResult>
  retryRecoveryItem: (itemId: ItemId) => Promise<void>
  /** Replaces an item whose local copy can't be decrypted with the server's copy */
  replaceFromServer: (itemId: ItemId) => Promise<void>
  forceOverwriteRecoveryItem: (itemId: ItemId) => Promise<void>
  forceDeleteRecoveryItem: (itemId: ItemId) => Promise<void>
  recreateOversizedItem: (itemId: ItemId) => Promise<ItemId>
  dismissRecoveryItem: (entryId: string) => Promise<void>
  listRecoveryItems: (options?: ReadManualRecoveryOptions) => Promise<ManualRecoveryEntry[]>
  updateVaultKey: (vaultKey: string) => Promise<void>
  updateAuthToken: (token: string | null) => Promise<void>
  reencryptAllItems: () => Promise<ReencryptResult>
  exportSyncState: () => Promise<BackupSyncState>
  restoreSyncState: (state: Partial<BackupSyncState>) => Promise<void>
  claimLeader: () => Promise<void>
  /**
   * Reports this device's data level and asks the server to raise the account's, which it does only
   * once the account's data has none of the app's blockers. For an app's migration app.
   */
  checkDataVersion: () => Promise<DataVersionStatus>
  shutdown: (options?: { clearLocalData?: boolean }) => Promise<void>
}
