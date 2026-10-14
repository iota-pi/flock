import type { VaultDoc, VaultMetadata } from '../shared/types'
import type { ManualRecoveryEntry, ReadManualRecoveryOptions } from '../shared/manualRecoveryStore'
import type { BackupSyncState } from '../shared/backupSyncState'
import { ItemId } from 'src/shared/vault/ids'

/**
 * The sync worker's Comlink API. `TDoc` and `TMeta` are the app's document and metadata types,
 * as produced by its DocCodec.
 */
export interface SyncApi<TDoc extends VaultDoc = VaultDoc, TMeta extends VaultMetadata = VaultMetadata> {
  initRepo: (
    accountId: string,
    vaultKey: string,
    refreshAuthToken?: () => Promise<string | null>
  ) => Promise<void>
  setOnlineState: (isOnline: boolean) => Promise<void>
  bootstrapItems: () => Promise<void>
  mutateItem: (id: ItemId, changes: Partial<TDoc>) => Promise<void>
  createItem: (item: TDoc) => Promise<void>
  storeItems: (items: TDoc[]) => Promise<void>
  mutateMetadata: (changes: Partial<TMeta>, options?: { pushRemote?: boolean }) => Promise<void>
  exportAllBinaries: () => Promise<{ documents: Partial<Record<string, string>>; skipped: string[] }>
  restoreFromBinaries: (documents: Partial<Record<string, string>>) => Promise<string[]>
  flushSync: () => Promise<void>
  fullResync: () => Promise<boolean>
  pushSnapshots: () => Promise<{ persisted: number; total: number }>
  retrySave: () => Promise<{ success: boolean; error?: string }>
  retryRecoveryItem: (itemId: ItemId) => Promise<void>
  forceOverwriteRecoveryItem: (itemId: ItemId) => Promise<void>
  forceDeleteRecoveryItem: (itemId: ItemId) => Promise<void>
  recreateOversizedItem: (itemId: ItemId) => Promise<ItemId>
  compactItem: (itemId: ItemId) => Promise<ItemId | void>
  dismissRecoveryItem: (entryId: string) => Promise<void>
  listRecoveryItems: (options?: ReadManualRecoveryOptions) => Promise<ManualRecoveryEntry[]>
  updateVaultKey: (vaultKey: string) => Promise<void>
  updateAuthToken: (token: string | null) => Promise<void>
  reencryptAllItems: (
    onProgress?: (done: number, total: number) => void,
    refreshAuthToken?: () => Promise<string | null>
  ) => Promise<{
    succeeded: ItemId[]
    failed: Array<{ itemId: ItemId; error: string }>
  }>
  exportSyncState: () => Promise<BackupSyncState>
  restoreSyncState: (state: Partial<BackupSyncState>) => Promise<void>
  claimLeader: () => Promise<void>
  shutdown: (options?: { clearLocalData?: boolean }) => Promise<void>
}
