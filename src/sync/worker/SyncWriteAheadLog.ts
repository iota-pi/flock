import localforage from 'localforage'
import { nanoid } from 'nanoid'
import type { ItemId } from 'src/shared/schemas/items'
import { runStorageOperation } from '../../utils/storageManager'

export interface WalEntry {
  id: string
  itemId: ItemId
  data: Uint8Array
  createdAt: number
}

function toUint8Array(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) {
    return data
  }
  if (data && typeof data === 'object') {
    const rawObj = data as Record<string | number, unknown>
    const length = typeof rawObj.length === 'number' && Number.isFinite(rawObj.length)
      ? rawObj.length
      : Object.keys(rawObj).length
    const arr: number[] = []
    for (let i = 0; i < length; i++) {
      const val = rawObj[i]
      arr.push(typeof val === 'number' ? val : 0)
    }
    return new Uint8Array(arr)
  }
  return new Uint8Array()
}

export class SyncWriteAheadLog {
  private readonly storage: LocalForage

  constructor(accountId: string) {
    this.storage = localforage.createInstance({
      name: `FlockVault_SyncWAL_${accountId}`,
      storeName: 'wal-entries',
    })
  }

  /**
   * Write a sync message to the WAL. Returns only after IndexedDB write completes.
   */
  async append(itemId: ItemId, data: Uint8Array): Promise<string> {
    const id = nanoid()
    const entry: WalEntry = {
      id,
      itemId,
      data,
      createdAt: Date.now(),
    }
    await runStorageOperation(() => this.storage.setItem(id, entry))
    return id
  }

  /**
   * Read all pending WAL entries, grouped by item, ordered by creation time.
   */
  async readAll(): Promise<Map<ItemId, WalEntry[]>> {
    const result = new Map<ItemId, WalEntry[]>()
    await this.storage.iterate<WalEntry, void>(entry => {
      if (entry && entry.id && entry.itemId && entry.data) {
        const normalizedData = toUint8Array(entry.data)
        const validEntry: WalEntry = {
          id: entry.id,
          itemId: entry.itemId,
          data: normalizedData,
          createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : 0,
        }
        const list = result.get(validEntry.itemId) ?? []
        list.push(validEntry)
        result.set(validEntry.itemId, list)
      }
    })

    for (const list of result.values()) {
      list.sort((a, b) => a.createdAt - b.createdAt)
    }

    return result
  }

  /**
   * Remove specific entries by ID after successful network send.
   */
  async remove(entryIds: string[]): Promise<void> {
    if (entryIds.length === 0) return
    await Promise.all(entryIds.map(id => this.storage.removeItem(id)))
  }

  /**
   * Clear all entries (used on account switch or data clear).
   */
  async clear(): Promise<void> {
    await this.storage.clear()
  }
}
