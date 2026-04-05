import type { Item } from '../../state/items'
import { mergeDeltaItems } from '../../state/items'
import { syncDB } from '../db'
import type { VaultItem } from './client'
import { getLastSyncServerTime } from '../../sync/syncServerTimeStore'
import type { AccountMetadata } from '../../state/metadata'

type PersistedItemsSyncState = {
  items: Item[]
}

type PullDependencies = {
  fetchDelta: (accountId: string, cacheTime: number | null) => Promise<{ items: VaultItem[]; serverTime: number }>
  decryptItems: (items: VaultItem[]) => Promise<Item[]>
  migrateItems: (items: Item[], metadata: AccountMetadata) => Promise<unknown>
}

const SYNC_ENGINE_STORAGE_KEY_PREFIX = 'items-sync-engine'

function getStorageKey(accountId: string): string {
  return `${SYNC_ENGINE_STORAGE_KEY_PREFIX}_${accountId}`
}

class ItemsSyncEngine {
  private loadedAccountId: string | null = null
  private items: Item[] = []
  private dependencies: PullDependencies | null = null

  initialize(dependencies: PullDependencies): void {
    this.dependencies = dependencies
  }

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

  private requireDependencies(): PullDependencies {
    if (!this.dependencies) {
      throw new Error('ItemsSyncEngine is not initialized')
    }

    return this.dependencies
  }

  async pull(input: {
    accountId: string
    metadata: AccountMetadata
  }): Promise<Item[]> {
    const dependencies = this.requireDependencies()
    await this.load(input.accountId)

    const lastSyncServerTime = getLastSyncServerTime(input.accountId)
    const cacheTime = this.items.length > 0 && typeof lastSyncServerTime === 'number'
      ? lastSyncServerTime
      : null

    const response = await dependencies.fetchDelta(input.accountId, cacheTime)
    const decrypted = await dependencies.decryptItems(response.items)
    const deletedIds = new Set(
      response.items
        .filter(item => item.metadata?.deleted === true)
        .map(item => item.item),
    )
    const incoming = decrypted.filter(item => !deletedIds.has(item.id))

    this.items = cacheTime === null
      ? incoming
      : mergeDeltaItems(this.items, incoming, deletedIds)

    await dependencies.migrateItems(this.items, input.metadata)

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