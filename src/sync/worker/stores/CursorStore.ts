import localforage from 'localforage'
import type { ItemId } from 'src/shared/schemas/items'
import { BaseLocalForageStore } from './BaseLocalForageStore'
import {
  getSyncMetadataStorage,
  hasLegacyDatabase,
  SYNC_METADATA_KEYS,
  LEGACY_DB_NAMES,
  LEGACY_KEYS,
} from './syncMetadataStorage'
import type { RunStorageOperationOptions } from '../../../utils/storageManager'

export class CursorStore extends BaseLocalForageStore {
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

  async loadCursors(): Promise<[ItemId, number][] | null> {
    const cursors = await this.getItem<[ItemId, number][]>(SYNC_METADATA_KEYS.CURSORS)
    if (cursors !== null && Array.isArray(cursors)) {
      return cursors
    }

    return this.migrateLegacyCursors()
  }

  async saveCursors(cursors: [ItemId, number][]): Promise<void> {
    await this.setItem(SYNC_METADATA_KEYS.CURSORS, cursors)
  }

  override async clear(options?: RunStorageOperationOptions): Promise<void> {
    await this.removeItem(SYNC_METADATA_KEYS.CURSORS, options)
    await this.removeItem(LEGACY_KEYS.CURSORS, options).catch(() => {})
  }

  private async migrateLegacyCursors(): Promise<[ItemId, number][] | null> {
    // 1. Check in-store legacy key
    const inStoreLegacy = await this.getItem<[ItemId, number][]>(LEGACY_KEYS.CURSORS)
    if (inStoreLegacy && Array.isArray(inStoreLegacy)) {
      await this.saveCursors(inStoreLegacy)
      await this.removeItem(LEGACY_KEYS.CURSORS).catch(() => {})
      return inStoreLegacy
    }

    // 2. Check legacy database
    if (this.accountId) {
      try {
        const hasLegacy = await hasLegacyDatabase(LEGACY_DB_NAMES.CURSORS)
        if (hasLegacy) {
          const legacyStore = localforage.createInstance({
            name: LEGACY_DB_NAMES.CURSORS,
            storeName: `cursors-${this.accountId}`,
          })
          const legacyData = await legacyStore.getItem<[ItemId, number][]>(LEGACY_KEYS.CURSORS)
          if (legacyData && Array.isArray(legacyData)) {
            await this.saveCursors(legacyData)
            await legacyStore.removeItem(LEGACY_KEYS.CURSORS).catch(() => {})
            return legacyData
          }
        }
      } catch (err) {
        console.warn('[CursorStore] Failed to migrate legacy cursors:', err)
      }
    }

    return null
  }
}
