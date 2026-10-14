import type { DocumentId } from '@automerge/automerge-repo/slim'
import {
  ScopedMetadataStore,
  SYNC_METADATA_KEYS,
  getLegacySyncDatabaseNames,
  LEGACY_KEYS,
} from './syncMetadataStorage'

export class SyncedHeadsStore extends ScopedMetadataStore<[DocumentId, string[]][]> {
  constructor(accountIdOrStore: string | LocalForage) {
    super(accountIdOrStore, {
      metadataKey: SYNC_METADATA_KEYS.SYNCED_HEADS,
      legacyKey: LEGACY_KEYS.SYNCED_HEADS,
      legacyDbName: getLegacySyncDatabaseNames()?.syncedHeads,
      legacyStorePrefix: 'synced-heads',
      storeLabel: 'SyncedHeadsStore',
      normalize: (raw: unknown) =>
        Array.isArray(raw) ? (raw as [DocumentId, string[]][]) : null,
    })
  }

  async loadSyncedHeads(): Promise<[DocumentId, string[]][] | null> {
    return this.getScopedData()
  }

  async saveSyncedHeads(syncedHeads: [DocumentId, string[]][]): Promise<void> {
    await this.setScopedData(syncedHeads)
  }
}
