import type { Item } from '../state/items'
import type { AccountMetadata } from '../state/metadata'
import { SyncStatus } from 'src/state/syncStore'
import type { ManualRecoveryEntry } from '../sync/manualRecoveryStore'
import type { BackupSyncState } from '../types/backup'

export interface SyncCallbacks {
  onReady: () => Promise<void>,
  onStatusChange: (status: SyncStatus) => Promise<void>,
  onItemUpdated: (id: string, item: Item | null) => Promise<void>,
  onIndexUpdated: (itemIds: string[]) => Promise<void>,
  onMetadataUpdated: (metadata: AccountMetadata) => Promise<void>,
  onMutationFailed: (mutationId: string, error: string) => Promise<void>,
  onStartRequest: () => Promise<void>,
  onFinishRequest: () => Promise<void>,
  onAuthFailure: (message: string) => Promise<void>,
  onRecoveryItemsChanged: (entries: ManualRecoveryEntry[]) => Promise<void>,
  onQuotaExceeded?: (message: string) => Promise<void>,
}

export interface SyncApi {
  initRepo: (accountId: string, vaultKey: string, callbacks: SyncCallbacks) => Promise<void>
  setOnlineState: (isOnline: boolean) => Promise<void>
  bootstrapLegacyItems: () => Promise<void>
  mutateItem: (mutationId: string, id: string, changes: Partial<Item>) => Promise<void>
  createItem: (item: Item) => Promise<void>
  hardDeleteItems: (itemIds: string[]) => Promise<void>
  storeItems: (items: Item[]) => Promise<void>
  mutateMetadata: (changes: Partial<AccountMetadata>) => Promise<void>
  clearAutomergeDocStore: () => Promise<void>
  exportAllBinaries: () => Promise<Partial<Record<string, string>>>
  restoreFromBinaries: (documents: Partial<Record<string, string>>) => Promise<string[]>
  forceSync: () => Promise<void>,
  pushSnapshots: () => Promise<{ persisted: number; total: number }>
  retryRecoveryItem: (itemId: string) => Promise<void>
  forceOverwriteRecoveryItem: (itemId: string) => Promise<void>
  forceDeleteRecoveryItem: (itemId: string) => Promise<void>
  dismissRecoveryItem: (entryId: string) => Promise<void>
  listRecoveryItems: () => Promise<ManualRecoveryEntry[]>
  updateVaultKey: (vaultKey: string) => Promise<void>
  reencryptAllItems: (onProgress: (done: number, total: number) => void) => Promise<void>
  exportSyncState: () => Promise<BackupSyncState>
  restoreSyncState: (state: Partial<BackupSyncState>) => Promise<void>
  shutdown: () => Promise<void>
  ping: () => Promise<void>
}
