import type { Remote } from 'comlink'
import type { Item } from '../state/items'
import type { AccountMetadata } from '../state/metadata'

export interface SyncCallbacks {
  onReady: (state: { items: Record<string, Item>; itemIds: string[]; metadata: AccountMetadata }) => void
  onItemUpdated: (id: string, item: Item | null) => void
  onIndexUpdated: (itemIds: string[]) => void
  onMetadataUpdated: (metadata: AccountMetadata) => void
  onMutationFailed: (mutationId: string, error: string) => void
}

export interface SyncApi {
  initRepo: (accountId: string, vaultKey: string, callbacks: Remote<SyncCallbacks>) => Promise<void>
  mutateItem: (mutationId: string, id: string, changes: Partial<Item>) => Promise<void>
  createItem: (item: Item) => Promise<void>
  deleteItem: (id: string) => Promise<void>
  hardDeleteItems: (itemIds: string[]) => Promise<void>
  storeItems: (items: Item[]) => Promise<void>
  mutateMetadata: (changes: Partial<AccountMetadata>) => Promise<void>
  clearAutomergeDocStore: () => Promise<void>
  exportAllBinaries: () => Promise<Partial<Record<string, string>>>
  restoreFromBinaries: (documents: Partial<Record<string, string>>) => Promise<string[]>
}
