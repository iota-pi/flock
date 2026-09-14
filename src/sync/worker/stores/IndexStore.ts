import localforage from 'localforage'
import type { AutomergeIndexDocument } from '../docStore/AutomergeDocStore'
import { BaseLocalForageStore } from './BaseLocalForageStore'
import {
  getSyncMetadataStorage,
  hasLegacyDatabase,
  SYNC_METADATA_KEYS,
  LEGACY_DB_NAMES,
  LEGACY_KEYS,
} from './syncMetadataStorage'
import type { RunStorageOperationOptions } from '../../../utils/storageManager'

export class IndexStore extends BaseLocalForageStore {
  private readonly accountId: string | null

  constructor(accountIdOrStore: string | LocalForage) {
    if (typeof accountIdOrStore === 'string') {
      super(getSyncMetadataStorage(accountIdOrStore))
      this.accountId = accountIdOrStore
    } else {
      super(accountIdOrStore)
      this.accountId = null
    }
  }

  async getIndex(): Promise<AutomergeIndexDocument | null> {
    const doc = await this.getItem<AutomergeIndexDocument>(SYNC_METADATA_KEYS.INDEX_DOC)
    if (doc !== null) {
      return doc
    }

    return this.migrateLegacyIndex()
  }

  async saveIndex(indexDoc: AutomergeIndexDocument): Promise<void> {
    await this.setItem(SYNC_METADATA_KEYS.INDEX_DOC, indexDoc)
  }

  override async clear(options?: RunStorageOperationOptions): Promise<void> {
    await this.removeItem(SYNC_METADATA_KEYS.INDEX_DOC, options)
  }

  private async migrateLegacyIndex(): Promise<AutomergeIndexDocument | null> {
    if (this.accountId) {
      try {
        const hasLegacy = await hasLegacyDatabase(LEGACY_DB_NAMES.INDEX_DOC)
        if (hasLegacy) {
          const legacyStore = localforage.createInstance({
            name: LEGACY_DB_NAMES.INDEX_DOC,
            storeName: `index-${this.accountId}`,
          })
          const legacyDoc = await legacyStore.getItem<AutomergeIndexDocument>(LEGACY_KEYS.INDEX_DOC)
          if (legacyDoc !== null) {
            await this.saveIndex(legacyDoc)
            await legacyStore.removeItem(LEGACY_KEYS.INDEX_DOC).catch(() => {})
            return legacyDoc
          }
        }
      } catch (err) {
        console.warn('[IndexStore] Failed to migrate legacy indexDoc:', err)
      }
    }

    return null
  }
}
