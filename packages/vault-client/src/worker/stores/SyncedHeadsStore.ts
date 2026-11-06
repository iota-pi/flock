import type { ItemId } from '@vault/shared'
import { ScopedMetadataStore, SYNC_METADATA_KEYS } from './syncMetadataStorage'

/** Each item's server heads, which only the leader writes (see ServerHeads) */
export class SyncedHeadsStore extends ScopedMetadataStore<[ItemId, string[]][]> {
  constructor(accountId: string) {
    super(accountId, {
      metadataKey: SYNC_METADATA_KEYS.SYNCED_HEADS,
      normalize: (raw: unknown) =>
        Array.isArray(raw) ? (raw as [ItemId, string[]][]) : null,
    })
  }

  async loadSyncedHeads(): Promise<[ItemId, string[]][] | null> {
    return this.getScopedData()
  }

  async saveSyncedHeads(syncedHeads: [ItemId, string[]][]): Promise<void> {
    await this.setScopedData(syncedHeads)
  }
}
