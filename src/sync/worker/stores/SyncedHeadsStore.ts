import type { DocumentId } from '@automerge/automerge-repo/slim'
import { BaseLocalForageStore } from './BaseLocalForageStore'

export class SyncedHeadsStore extends BaseLocalForageStore {
  constructor(accountId: string) {
    super({
      name: 'flock-sync-synced-heads',
      storeName: `synced-heads-${accountId}`,
    })
  }

  async loadSyncedHeads(): Promise<[DocumentId, string[]][] | null> {
    const data = await this.getItem<unknown>('syncedHeadsByDocId')
    if (!Array.isArray(data)) {
      return null
    }
    return data as [DocumentId, string[]][]
  }

  async saveSyncedHeads(syncedHeads: [DocumentId, string[]][]): Promise<void> {
    await this.setItem('syncedHeadsByDocId', syncedHeads)
  }
}
