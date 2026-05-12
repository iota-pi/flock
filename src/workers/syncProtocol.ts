import type { Item } from '../state/items'
import type { AccountMetadata } from '../state/metadata'
import { SyncStatus } from 'src/state/syncStore'

export interface SyncCallbacks {
  onReady: () => Promise<void>,
  onStatusChange: (status: SyncStatus) => Promise<void>,
  onItemUpdated: (id: string, item: Item | null) => Promise<void>,
  onIndexUpdated: (itemIds: string[]) => Promise<void>,
  onMetadataUpdated: (metadata: AccountMetadata) => Promise<void>,
  onMutationFailed: (mutationId: string, error: string) => Promise<void>,
}

export interface SyncApi {
  initRepo: (accountId: string, vaultKey: string, callbacks: SyncCallbacks) => Promise<void>
  mutateItem: (mutationId: string, id: string, changes: Partial<Item>) => Promise<void>
  createItem: (item: Item) => Promise<void>
  hardDeleteItems: (itemIds: string[]) => Promise<void>
  storeItems: (items: Item[]) => Promise<void>
  mutateMetadata: (changes: Partial<AccountMetadata>) => Promise<void>
  clearAutomergeDocStore: () => Promise<void>
  exportAllBinaries: () => Promise<Partial<Record<string, string>>>
  restoreFromBinaries: (documents: Partial<Record<string, string>>) => Promise<string[]>
}
