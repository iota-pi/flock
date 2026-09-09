import localforage from 'localforage'
import type { DocumentId } from '@automerge/automerge-repo/slim'
import { runStorageOperation } from '../../../utils/storageManager'

export class SyncedHeadsStore {
  private readonly store: LocalForage
  private readonly storeName: string

  constructor(accountId: string) {
    this.storeName = `synced-heads-${accountId}`
    this.store = localforage.createInstance({
      name: 'flock-sync-synced-heads',
      storeName: this.storeName,
    })
  }

  async loadSyncedHeads(): Promise<[DocumentId, string[]][] | null> {
    const data = await this.store.getItem<unknown>('syncedHeadsByDocId')
    if (!Array.isArray(data)) {
      return null
    }
    return data as [DocumentId, string[]][]
  }

  async saveSyncedHeads(syncedHeads: [DocumentId, string[]][]): Promise<void> {
    await runStorageOperation(() => this.store.setItem('syncedHeadsByDocId', syncedHeads))
  }

  async clear(): Promise<void> {
    await this.store.clear()
  }
}
