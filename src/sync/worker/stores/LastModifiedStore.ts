import localforage from 'localforage'
import type { ItemId } from 'src/shared/schemas/items'
import { runStorageOperation } from '../../../utils/storageManager'

export class LastModifiedStore {
  private readonly store: LocalForage
  private readonly storeName: string

  constructor(accountId: string) {
    this.storeName = `last-modified-${accountId}`
    this.store = localforage.createInstance({
      name: 'flock-sync-last-modified',
      storeName: this.storeName,
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

  async drop(): Promise<void> {
    await localforage.dropInstance({
      name: 'flock-sync-last-modified',
      storeName: this.storeName,
    })
  }
}
