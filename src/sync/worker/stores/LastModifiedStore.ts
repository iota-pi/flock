import localforage from 'localforage'
import type { ItemId } from 'src/shared/schemas/items'
import { runStorageOperation } from '../../../utils/storageManager'

export class LastModifiedStore {
  private readonly store: LocalForage

  constructor(accountId: string) {
    this.store = localforage.createInstance({
      name: 'flock-sync-last-modified',
      storeName: `last-modified-${accountId}`,
    })
  }

  async loadLastModified(): Promise<[ItemId, number][] | null> {
    return this.store.getItem<[ItemId, number][]>('lastModifiedByItemId')
  }

  async saveLastModified(lastModified: [ItemId, number][]): Promise<void> {
    await runStorageOperation(() => this.store.setItem('lastModifiedByItemId', lastModified))
  }

  async clear(): Promise<void> {
    await this.store.clear()
  }
}
