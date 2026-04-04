import type { Item } from '../../state/items'
import { mergeDeltaItems } from '../../state/items'
import { syncDB } from '../db'
import type { VaultItem } from './client'
import { getLastSyncServerTime } from '../../sync/syncServerTimeStore'
import type { AccountMetadata } from '../../state/metadata'

type PersistedItemsSyncState = {
  items: Item[]
}

const SYNC_ENGINE_STORAGE_KEY_PREFIX = 'items-sync-engine'

function getStorageKey(accountId: string): string {
  return `${SYNC_ENGINE_STORAGE_KEY_PREFIX}_${accountId}`
}

class ItemsSyncEngine {
  private loadedAccountId: string | null = null
  private items: Item[] = []

  reset(): void {
    this.loadedAccountId = null
    this.items = []
  }

  private async load(accountId: string): Promise<void> {
    if (this.loadedAccountId === accountId) {
      return
    }

    const persisted = await syncDB.getItem<PersistedItemsSyncState>(getStorageKey(accountId))
    this.items = Array.isArray(persisted?.items) ? persisted.items : []
    this.loadedAccountId = accountId
  }

  private async persist(accountId: string): Promise<void> {
    await syncDB.setItem(getStorageKey(accountId), { items: this.items })
  }

  async pull(input: {
    accountId: string
    metadata: AccountMetadata
    fetchDelta: (cacheTime: number | null) => Promise<{ items: VaultItem[]; serverTime: number }>
    decryptItems: (items: VaultItem[]) => Promise<Item[]>
    migrateItems: (items: Item[], metadata: AccountMetadata) => Promise<unknown>
  }): Promise<Item[]> {
    await this.load(input.accountId)

    const lastSyncServerTime = getLastSyncServerTime(input.accountId)
    const cacheTime = this.items.length > 0 && typeof lastSyncServerTime === 'number'
      ? lastSyncServerTime
      : null

    const response = await input.fetchDelta(cacheTime)
    const decrypted = await input.decryptItems(response.items)
    const deletedIds = new Set(
      response.items
        .filter(item => item.metadata?.deleted === true)
        .map(item => item.item),
    )
    const incoming = decrypted.filter(item => !deletedIds.has(item.id))

    this.items = cacheTime === null
      ? incoming
      : mergeDeltaItems(this.items, incoming, deletedIds)

    await input.migrateItems(this.items, input.metadata)

    await this.persist(input.accountId)
    return this.items
  }

  async applyRealtimeDelta(input: {
    accountId: string
    decryptedDelta: Item[]
    deletedIds: Set<string>
  }): Promise<Item[]> {
    await this.load(input.accountId)

    this.items = mergeDeltaItems(this.items, input.decryptedDelta, input.deletedIds)
    await this.persist(input.accountId)
    return this.items
  }
}

export const itemsSyncEngine = new ItemsSyncEngine()