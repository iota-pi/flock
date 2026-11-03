import { ScopedMetadataStore, SYNC_METADATA_KEYS } from './syncMetadataStorage'

/** When this device last completed a sync with the server, shared by the account's tabs */
export class LastSyncedStore extends ScopedMetadataStore<number> {
  constructor(accountId: string) {
    super(accountId, {
      metadataKey: SYNC_METADATA_KEYS.LAST_SYNCED_AT,
      normalize: raw => (typeof raw === 'number' && Number.isFinite(raw) ? raw : null),
    })
  }

  async load(): Promise<number | null> {
    return this.getScopedData()
  }

  async save(timestamp: number): Promise<void> {
    await this.setScopedData(timestamp)
  }
}
