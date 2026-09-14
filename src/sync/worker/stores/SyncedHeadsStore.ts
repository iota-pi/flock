import localforage from 'localforage'
import type { DocumentId } from '@automerge/automerge-repo/slim'
import { BaseLocalForageStore } from './BaseLocalForageStore'
import {
  getSyncMetadataStorage,
  hasLegacyDatabase,
  SYNC_METADATA_KEYS,
  LEGACY_DB_NAMES,
  LEGACY_KEYS,
} from './syncMetadataStorage'
import type { RunStorageOperationOptions } from '../../../utils/storageManager'

export class SyncedHeadsStore extends BaseLocalForageStore {
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

  async loadSyncedHeads(): Promise<[DocumentId, string[]][] | null> {
    const data = await this.getItem<unknown>(SYNC_METADATA_KEYS.SYNCED_HEADS)
    if (Array.isArray(data)) {
      return data as [DocumentId, string[]][]
    }

    return this.migrateLegacySyncedHeads()
  }

  async saveSyncedHeads(syncedHeads: [DocumentId, string[]][]): Promise<void> {
    await this.setItem(SYNC_METADATA_KEYS.SYNCED_HEADS, syncedHeads)
  }

  override async clear(options?: RunStorageOperationOptions): Promise<void> {
    await this.removeItem(SYNC_METADATA_KEYS.SYNCED_HEADS, options)
    await this.removeItem(LEGACY_KEYS.SYNCED_HEADS, options).catch(() => {})
  }

  private async migrateLegacySyncedHeads(): Promise<[DocumentId, string[]][] | null> {
    // 1. Check in-store legacy key
    const inStoreLegacy = await this.getItem<unknown>(LEGACY_KEYS.SYNCED_HEADS)
    if (Array.isArray(inStoreLegacy)) {
      const data = inStoreLegacy as [DocumentId, string[]][]
      await this.saveSyncedHeads(data)
      await this.removeItem(LEGACY_KEYS.SYNCED_HEADS).catch(() => {})
      return data
    }

    // 2. Check legacy database
    if (this.accountId) {
      try {
        const hasLegacy = await hasLegacyDatabase(LEGACY_DB_NAMES.SYNCED_HEADS)
        if (hasLegacy) {
          const legacyStore = localforage.createInstance({
            name: LEGACY_DB_NAMES.SYNCED_HEADS,
            storeName: `synced-heads-${this.accountId}`,
          })
          const legacyData = await legacyStore.getItem<unknown>(LEGACY_KEYS.SYNCED_HEADS)
          if (Array.isArray(legacyData)) {
            const data = legacyData as [DocumentId, string[]][]
            await this.saveSyncedHeads(data)
            await legacyStore.removeItem(LEGACY_KEYS.SYNCED_HEADS).catch(() => {})
            return data
          }
        }
      } catch (err) {
        console.warn('[SyncedHeadsStore] Failed to migrate legacy synced heads:', err)
      }
    }

    return null
  }
}
