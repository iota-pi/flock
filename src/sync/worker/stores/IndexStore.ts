import localforage from 'localforage'
import type { AutomergeIndexDocument } from '../docStore/AutomergeDocStore'

export class IndexStore {
  private readonly store: LocalForage

  constructor(accountId: string) {
    this.store = localforage.createInstance({
      name: 'flock-item-metadata',
      storeName: `index-${accountId}`,
    })
  }

  async getIndex(): Promise<AutomergeIndexDocument | null> {
    return this.store.getItem<AutomergeIndexDocument>('indexDoc')
  }

  async saveIndex(indexDoc: AutomergeIndexDocument): Promise<void> {
    await this.store.setItem('indexDoc', indexDoc)
  }

  async clear(): Promise<void> {
    await this.store.clear()
  }
}
