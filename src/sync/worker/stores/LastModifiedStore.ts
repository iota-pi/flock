import type { ItemId } from 'src/shared/schemas/items'
import {
  ScopedMetadataStore,
  SYNC_METADATA_KEYS,
  LEGACY_DB_NAMES,
  LEGACY_KEYS,
} from './syncMetadataStorage'

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

export class LastModifiedStore extends ScopedMetadataStore<[ItemId, ItemSyncTimestamps][]> {
  constructor(accountIdOrStore: string | LocalForage) {
    super(accountIdOrStore, {
      metadataKey: SYNC_METADATA_KEYS.LAST_MODIFIED,
      legacyKey: LEGACY_KEYS.LAST_MODIFIED,
      legacyDbName: LEGACY_DB_NAMES.LAST_MODIFIED,
      legacyStorePrefix: 'last-modified',
      storeLabel: 'LastModifiedStore',
      normalize: (raw: unknown) =>
        Array.isArray(raw) ? normalizeTimestamps(raw as [ItemId, number | ItemSyncTimestamps][]) : null,
    })
  }

  async loadTimestamps(): Promise<[ItemId, ItemSyncTimestamps][] | null> {
    return this.getScopedData()
  }

  async saveTimestamps(timestamps: [ItemId, ItemSyncTimestamps][]): Promise<void> {
    await this.setScopedData(timestamps)
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
}
