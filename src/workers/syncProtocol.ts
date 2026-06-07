import type { SyncEventListener } from '../sync/SyncEventHub'
import type { Item } from '../state/items'
import type { AccountMetadata } from '../state/metadata'
import { SyncStatus } from 'src/state/syncStore'
import type { ManualRecoveryEntry } from '../sync/manualRecoveryStore'
import type { BackupSyncState } from '../types/backup'
import { ItemId } from 'src/shared/schemas/items'

export interface SyncApi {
  initRepo: (accountId: string, vaultKey: string, onEvent: SyncEventListener) => Promise<void>
  setOnlineState: (isOnline: boolean) => Promise<void>
  bootstrapLegacyItems: () => Promise<void>
  mutateItem: (mutationId: string, id: ItemId, changes: Partial<Item>) => Promise<void>
  createItem: (item: Item) => Promise<void>
  hardDeleteItems: (itemIds: ItemId[]) => Promise<void>
  storeItems: (items: Item[]) => Promise<void>
  mutateMetadata: (changes: Partial<AccountMetadata>) => Promise<void>
  exportAllBinaries: () => Promise<Partial<Record<string, string>>>
  restoreFromBinaries: (documents: Partial<Record<string, string>>) => Promise<string[]>
  forceSync: () => Promise<void>,
  pushSnapshots: () => Promise<{ persisted: number; total: number }>
  retryRecoveryItem: (itemId: ItemId) => Promise<void>
  forceOverwriteRecoveryItem: (itemId: ItemId) => Promise<void>
  forceDeleteRecoveryItem: (itemId: ItemId) => Promise<void>
  dismissRecoveryItem: (entryId: string) => Promise<void>
  listRecoveryItems: () => Promise<ManualRecoveryEntry[]>
  updateVaultKey: (vaultKey: string) => Promise<void>
  reencryptAllItems: (onProgress: (done: number, total: number) => void) => Promise<void>
  exportSyncState: () => Promise<BackupSyncState>
  restoreSyncState: (state: Partial<BackupSyncState>) => Promise<void>
  shutdown: () => Promise<void>
  ping: () => Promise<void>
}
