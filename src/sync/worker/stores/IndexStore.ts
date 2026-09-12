import type { AutomergeIndexDocument } from '../docStore/AutomergeDocStore'
import { BaseLocalForageStore } from './BaseLocalForageStore'

export class IndexStore extends BaseLocalForageStore {
  constructor(accountId: string) {
    super({
      name: 'flock-item-metadata',
      storeName: `index-${accountId}`,
    })
  }

  async getIndex(): Promise<AutomergeIndexDocument | null> {
    return this.getItem<AutomergeIndexDocument>('indexDoc')
  }

  async saveIndex(indexDoc: AutomergeIndexDocument): Promise<void> {
    await this.setItem('indexDoc', indexDoc)
  }
}
