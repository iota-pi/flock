import localforage from 'localforage'
import type { AutomergeIndexDocument } from '../docStore/AutomergeDocStore'
import { runStorageOperation } from 'src/utils/storageManager'

export class IndexStore {
  private readonly store: LocalForage
  private readonly storeName: string

  constructor(accountId: string) {
    this.storeName = `index-${accountId}`
    this.store = localforage.createInstance({
      name: 'flock-item-metadata',
      storeName: this.storeName,
    })
  }

  async getIndex(): Promise<AutomergeIndexDocument | null> {
    return this.store.getItem<AutomergeIndexDocument>('indexDoc')
  }

  async saveIndex(indexDoc: AutomergeIndexDocument): Promise<void> {
    await runStorageOperation(() => this.store.setItem('indexDoc', indexDoc))
  }

  async clear(): Promise<void> {
    await this.store.clear()
  }

  async drop(): Promise<void> {
    await localforage.dropInstance({
      name: 'flock-item-metadata',
      storeName: this.storeName,
    })
  }
}
