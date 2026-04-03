import type { Item } from '../../state/items'
import { mergeDeltaItems } from '../../state/items'
import { syncDB } from '../db'
import type { VaultItem } from './client'
import { getLastSyncServerTime } from '../../sync/syncServerTimeStore'

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
    fetchDelta: (cacheTime: number | null) => Promise<{ items: VaultItem[]; serverTime: number }>
    decryptItems: (items: VaultItem[]) => Promise<Item[]>
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

    this.items = cacheTime === null
      ? decrypted
      : mergeDeltaItems(this.items, decrypted, deletedIds)

    await this.persist(input.accountId)
    return this.items
  }
}

export const itemsSyncEngine = new ItemsSyncEngine()