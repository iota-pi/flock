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

export interface ItemSyncTimestamps {
  localModifiedAt: number
  lastSnapshotAt?: number
}

function normalizeTimestamps(raw: [ItemId, number | ItemSyncTimestamps][]): [ItemId, ItemSyncTimestamps][] {
  return raw.map(([itemId, val]) => {
    if (typeof val === 'number') {
      return [itemId, { localModifiedAt: val, lastSnapshotAt: val }]
    }
    if (val && typeof val === 'object') {
      return [
        itemId,
        {
          localModifiedAt: typeof val.localModifiedAt === 'number' ? val.localModifiedAt : 0,
          lastSnapshotAt: typeof val.lastSnapshotAt === 'number' ? val.lastSnapshotAt : undefined,
        },
      ]
    }
    return [itemId, { localModifiedAt: 0 }]
  })
}

export class LastModifiedStore extends BaseLocalForageStore {
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

  async loadTimestamps(): Promise<[ItemId, ItemSyncTimestamps][] | null> {
    const raw = await this.getItem<[ItemId, number | ItemSyncTimestamps][]>(SYNC_METADATA_KEYS.LAST_MODIFIED)
    if (raw && Array.isArray(raw)) {
      return normalizeTimestamps(raw)
    }

    return this.migrateLegacyTimestamps()
  }

  async saveTimestamps(timestamps: [ItemId, ItemSyncTimestamps][]): Promise<void> {
    await this.setItem(SYNC_METADATA_KEYS.LAST_MODIFIED, timestamps)
  }

  async loadLastModified(): Promise<[ItemId, number][] | null> {
    const timestamps = await this.loadTimestamps()
    if (!timestamps) return null
    return timestamps.map(([itemId, ts]) => [itemId, ts.localModifiedAt])
  }

  async saveLastModified(lastModified: [ItemId, number][]): Promise<void> {
    const timestamps: [ItemId, ItemSyncTimestamps][] = lastModified.map(([itemId, mod]) => [
      itemId,
      { localModifiedAt: mod, lastSnapshotAt: mod },
    ])
    await this.saveTimestamps(timestamps)
  }

  override async clear(options?: RunStorageOperationOptions): Promise<void> {
    await this.removeItem(SYNC_METADATA_KEYS.LAST_MODIFIED, options)
    await this.removeItem(LEGACY_KEYS.LAST_MODIFIED, options).catch(() => {})
  }

  private async migrateLegacyTimestamps(): Promise<[ItemId, ItemSyncTimestamps][] | null> {
    // 1. Check in-store legacy key
    const inStoreLegacy = await this.getItem<[ItemId, number | ItemSyncTimestamps][]>(LEGACY_KEYS.LAST_MODIFIED)
    if (inStoreLegacy && Array.isArray(inStoreLegacy)) {
      const normalized = normalizeTimestamps(inStoreLegacy)
      await this.saveTimestamps(normalized)
      await this.removeItem(LEGACY_KEYS.LAST_MODIFIED).catch(() => {})
      return normalized
    }

    // 2. Check legacy database
    if (this.accountId) {
      try {
        const hasLegacy = await hasLegacyDatabase(LEGACY_DB_NAMES.LAST_MODIFIED)
        if (hasLegacy) {
          const legacyStore = localforage.createInstance({
            name: LEGACY_DB_NAMES.LAST_MODIFIED,
            storeName: `last-modified-${this.accountId}`,
          })
          const legacyRaw = await legacyStore.getItem<[ItemId, number | ItemSyncTimestamps][]>(LEGACY_KEYS.LAST_MODIFIED)
          if (legacyRaw && Array.isArray(legacyRaw)) {
            const normalized = normalizeTimestamps(legacyRaw)
            await this.saveTimestamps(normalized)
            await legacyStore.removeItem(LEGACY_KEYS.LAST_MODIFIED).catch(() => {})
            return normalized
          }
        }
      } catch (err) {
        console.warn('[LastModifiedStore] Failed to migrate legacy timestamps:', err)
      }
    }

    return null
  }
}
