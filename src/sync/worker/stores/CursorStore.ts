import localforage from 'localforage'
import type { ItemId } from 'src/shared/schemas/items'
import { runStorageOperation } from '../../../utils/storageManager'

export class CursorStore {
  private readonly store: LocalForage

  constructor(accountId: string) {
    this.store = localforage.createInstance({
      name: 'flock-sync-cursors',
      storeName: `cursors-${accountId}`,
    })
  }

  async loadCursors(): Promise<[ItemId, number][] | null> {
    return this.store.getItem<[ItemId, number][]>('cursorByItemId')
  }

  async saveCursors(cursors: [ItemId, number][]): Promise<void> {
    await runStorageOperation(() => this.store.setItem('cursorByItemId', cursors))
  }

  async clear(): Promise<void> {
    await this.store.clear()
  }
}
