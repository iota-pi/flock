import type { ItemId } from 'src/shared/vault/ids'
import { ScopedMetadataStore, SYNC_METADATA_KEYS } from './syncMetadataStorage'

export interface PersistedSyncCursors {
  globalCursor: number
  retries?: [ItemId, number][]
}

export class CursorStore extends ScopedMetadataStore<PersistedSyncCursors> {
  constructor(accountIdOrStore: string | LocalForage) {
    super(accountIdOrStore, {
      metadataKey: SYNC_METADATA_KEYS.CURSORS,
      normalize: (raw: unknown): PersistedSyncCursors | null => (
        raw && typeof raw === 'object' && 'globalCursor' in raw ? raw as PersistedSyncCursors : null
      ),
    })
  }

  async loadCursors(): Promise<PersistedSyncCursors | null> {
    return this.getScopedData()
  }

  async saveCursors(state: PersistedSyncCursors): Promise<void> {
    await this.setScopedData(state)
  }
}
