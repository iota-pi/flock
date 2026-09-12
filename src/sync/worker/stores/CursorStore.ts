import type { ItemId } from 'src/shared/schemas/items'
import { BaseLocalForageStore } from './BaseLocalForageStore'

export class CursorStore extends BaseLocalForageStore {
  constructor(accountId: string) {
    super({
      name: 'flock-sync-cursors',
      storeName: `cursors-${accountId}`,
    })
  }

  async loadCursors(): Promise<[ItemId, number][] | null> {
    return this.getItem<[ItemId, number][]>('cursorByItemId')
  }

  async saveCursors(cursors: [ItemId, number][]): Promise<void> {
    await this.setItem('cursorByItemId', cursors)
  }
}
