import type { AutomergeIndexDocument } from '../docStore/AutomergeDocStore'
import { LocalDataUnreadableError, type LocalCipher } from '../localEncryption/LocalCipher'
import { ScopedMetadataStore, SYNC_METADATA_KEYS } from './syncMetadataStorage'

export interface IndexStoreOptions {
  /** Seals the index with the device storage key, under its own key (`indexDocSealed`) */
  cipher?: LocalCipher
}

export class IndexStore extends ScopedMetadataStore<AutomergeIndexDocument> {
  private readonly cipher?: LocalCipher

  constructor(accountIdOrStore: string | LocalForage, options: IndexStoreOptions = {}) {
    super(accountIdOrStore, {
      metadataKey: options.cipher ? SYNC_METADATA_KEYS.INDEX_DOC_SEALED : SYNC_METADATA_KEYS.INDEX_DOC,
    })
    this.cipher = options.cipher
  }

  async getIndex(): Promise<AutomergeIndexDocument | null> {
    if (!this.cipher) return this.getScopedData()
    const sealed = await this.getItem<unknown>(this.metadataKey)
    if (sealed === null || sealed === undefined) return null
    try {
      const bytes = await this.cipher.open({ store: 'index' }, sealed)
      return JSON.parse(new TextDecoder().decode(bytes)) as AutomergeIndexDocument
    } catch (error) {
      // Its tombstones stop deleted items coming back, so an unreadable index must stop sync
      throw new LocalDataUnreadableError("This device's item index could not be decrypted", { cause: error })
    }
  }

  async saveIndex(indexDoc: AutomergeIndexDocument): Promise<void> {
    if (!this.cipher) {
      await this.setScopedData(indexDoc)
      return
    }
    const sealed = await this.cipher.seal({ store: 'index' }, new TextEncoder().encode(JSON.stringify(indexDoc)))
    await this.setItem(this.metadataKey, sealed)
  }

  /** Whether an index exists in either layout, checked without decrypting it */
  async hasIndex(): Promise<boolean> {
    for (const key of [SYNC_METADATA_KEYS.INDEX_DOC, SYNC_METADATA_KEYS.INDEX_DOC_SEALED]) {
      const value = await this.getItem<unknown>(key)
      if (value !== null && value !== undefined) return true
    }
    return false
  }
}
