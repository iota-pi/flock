import type { AutomergeIndexDocument } from '../docStore/AutomergeDocStore'
import {
  ScopedMetadataStore,
  SYNC_METADATA_KEYS,
  LEGACY_DB_NAMES,
  LEGACY_KEYS,
} from './syncMetadataStorage'

export class IndexStore extends ScopedMetadataStore<AutomergeIndexDocument> {
  constructor(accountIdOrStore: string | LocalForage) {
    super(accountIdOrStore, {
      metadataKey: SYNC_METADATA_KEYS.INDEX_DOC,
      legacyKey: LEGACY_KEYS.INDEX_DOC,
      legacyDbName: LEGACY_DB_NAMES.INDEX_DOC,
      legacyStorePrefix: 'index',
      storeLabel: 'IndexStore',
    })
  }

  async getIndex(): Promise<AutomergeIndexDocument | null> {
    return this.getScopedData()
  }

  async saveIndex(indexDoc: AutomergeIndexDocument): Promise<void> {
    await this.setScopedData(indexDoc)
  }
}
