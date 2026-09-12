import type { ItemId } from 'src/shared/schemas/items'
import { BaseLocalForageStore } from './BaseLocalForageStore'

export interface ItemSyncTimestamps {
  localModifiedAt: number
  lastSnapshotAt?: number
}

export class LastModifiedStore extends BaseLocalForageStore {
  constructor(accountId: string) {
    super({
      name: 'flock-sync-last-modified',
      storeName: `last-modified-${accountId}`,
    })
  }

  async loadTimestamps(): Promise<[ItemId, ItemSyncTimestamps][] | null> {
    const raw = await this.getItem<[ItemId, number | ItemSyncTimestamps][]>('lastModifiedByItemId')
    if (!raw || !Array.isArray(raw)) return null

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

  async saveTimestamps(timestamps: [ItemId, ItemSyncTimestamps][]): Promise<void> {
    await this.setItem('lastModifiedByItemId', timestamps)
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

