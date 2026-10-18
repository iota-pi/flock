import type { ItemId } from '@vault/shared'
import { ScopedMetadataStore, SYNC_METADATA_KEYS } from './syncMetadataStorage'

export interface ItemSyncTimestamps {
  localModifiedAt: number
  lastSnapshotAt?: number
  baseVersion?: number
}

function normalizeTimestamps(raw: [ItemId, ItemSyncTimestamps][]): [ItemId, ItemSyncTimestamps][] {
  return raw.map(([itemId, val]) => {
    if (val && typeof val === 'object') {
      return [
        itemId,
        {
          localModifiedAt: typeof val.localModifiedAt === 'number' ? val.localModifiedAt : 0,
          lastSnapshotAt: typeof val.lastSnapshotAt === 'number' ? val.lastSnapshotAt : undefined,
          baseVersion: typeof val.baseVersion === 'number' ? val.baseVersion : 0,
        },
      ]
    }
    return [itemId, { localModifiedAt: 0, baseVersion: 0 }]
  })
}

export class LastModifiedStore extends ScopedMetadataStore<[ItemId, ItemSyncTimestamps][]> {
  constructor(accountIdOrStore: string | LocalForage) {
    super(accountIdOrStore, {
      metadataKey: SYNC_METADATA_KEYS.LAST_MODIFIED,
      normalize: (raw: unknown) =>
        Array.isArray(raw) ? normalizeTimestamps(raw as [ItemId, ItemSyncTimestamps][]) : null,
    })
  }

  async loadTimestamps(): Promise<[ItemId, ItemSyncTimestamps][] | null> {
    return this.getScopedData()
  }

  async saveTimestamps(timestamps: [ItemId, ItemSyncTimestamps][]): Promise<void> {
    await this.setScopedData(timestamps)
  }
}
