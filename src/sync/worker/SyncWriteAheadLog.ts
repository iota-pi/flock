import localforage from 'localforage'
import { nanoid } from 'nanoid'
import type { ItemId } from 'src/shared/schemas/items'
import { runStorageOperation } from '../../utils/storageManager'
import { isQuotaError } from '../../utils/storageQuota'

export interface WalEntry {
  id: string
  itemId: ItemId
  data: Uint8Array
  createdAt: number
  isBatched?: boolean
}

/**
 * Combines multiple WAL entries for an item into a length-prefixed batched stream.
 * Compatible with parseBatchedMessages on the receiving end.
 */
export function packBatchedMessages(entries: WalEntry[]): Uint8Array {
  let totalLength = 0
  for (const e of entries) {
    if (e.isBatched) {
      totalLength += e.data.length
    } else {
      totalLength += 4 + e.data.length
    }
  }
  const combined = new Uint8Array(totalLength)
  const view = new DataView(combined.buffer, combined.byteOffset, combined.byteLength)
  let offset = 0
  for (const e of entries) {
    if (e.isBatched) {
      combined.set(e.data, offset)
      offset += e.data.length
    } else {
      view.setUint32(offset, e.data.length, false)
      offset += 4
      combined.set(e.data, offset)
      offset += e.data.length
    }
  }
  return combined
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

const storageInstances = new Map<string, LocalForage>()

export function clearWalInstancesCacheForTesting(): void {
  storageInstances.clear()
}

export class SyncWriteAheadLog {
  public static readonly MAX_ENTRIES = 2000
  private static readonly PRUNE_BATCH_SIZE = 100

  private readonly storage: LocalForage

  public static getStorage(accountId: string): LocalForage {
    let instance = storageInstances.get(accountId)
    if (!instance) {
      instance = localforage.createInstance({
        name: `FlockVault_SyncWAL_${accountId}`,
        storeName: 'wal-entries',
      })
      storageInstances.set(accountId, instance)
    }
    return instance
  }

  /**
   * Clear all entries for an account without needing an active instance.
   */
  public static async clear(accountId: string): Promise<void> {
    if (!accountId) return
    const storage = SyncWriteAheadLog.getStorage(accountId)
    await storage.clear()
  }

  constructor(accountId: string) {
    this.storage = SyncWriteAheadLog.getStorage(accountId)
  }

  /**
   * Compacts WAL by grouping entries by itemId and merging multiple entries
   * into a single batched entry per itemId.
   * Returns the number of entries reduced.
   */
  async compact(): Promise<number> {
    const byItem = await this.readAll()
    let reducedCount = 0

    for (const [itemId, entries] of byItem.entries()) {
      if (entries.length <= 1) continue

      const combinedData = packBatchedMessages(entries)
      const latestCreatedAt = Math.max(...entries.map(e => e.createdAt || 0))
      const newId = nanoid()

      const compactedEntry: WalEntry = {
        id: newId,
        itemId,
        data: combinedData,
        createdAt: latestCreatedAt,
        isBatched: true,
      }

      // Save new compacted entry first
      await runStorageOperation(() => this.storage.setItem(newId, compactedEntry))

      // Remove the old individual entries
      const oldIds = entries.map(e => e.id)
      await this.remove(oldIds)

      reducedCount += entries.length - 1
    }

    return reducedCount
  }

  /**
   * Prunes oldest entries from WAL to keep size within limits or free space.
   */
  private async pruneOldest(count: number): Promise<void> {
    if (count <= 0) return
    try {
      const allEntries: { id: string; createdAt: number }[] = []
      await this.storage.iterate<WalEntry, void>(entry => {
        if (entry && entry.id) {
          allEntries.push({
            id: entry.id,
            createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : 0,
          })
        }
      })
      allEntries.sort((a, b) => a.createdAt - b.createdAt)
      const toRemove = allEntries.slice(0, count).map(e => e.id)
      await this.remove(toRemove)
    } catch (err) {
      console.error('[SyncWriteAheadLog] Failed to prune oldest entries', err)
    }
  }

  private async enforceSizeLimit(): Promise<void> {
    try {
      const currentLength = await this.storage.length()
      if (currentLength >= SyncWriteAheadLog.MAX_ENTRIES) {
        console.warn(
          `[SyncWriteAheadLog] WAL entry count (${currentLength}) reached threshold (${SyncWriteAheadLog.MAX_ENTRIES}). Compacting entries by item...`
        )
        // Step 1: Compact multiple entries per item
        await this.compact()

        const newLength = await this.storage.length()
        // Step 2: If still over limit (e.g. >2,000 unique items), prune oldest
        if (newLength >= SyncWriteAheadLog.MAX_ENTRIES) {
          const overflow = newLength - SyncWriteAheadLog.MAX_ENTRIES + SyncWriteAheadLog.PRUNE_BATCH_SIZE
          console.warn(
            `[SyncWriteAheadLog] WAL still at ${newLength} entries after compaction. Pruning ${overflow} oldest entries.`
          )
          await this.pruneOldest(overflow)
        }
      }
    } catch (err) {
      console.error('[SyncWriteAheadLog] Error checking WAL size limit', err)
    }
  }

  /**
   * Write a sync message to the WAL. Returns only after IndexedDB write completes.
   */
  async append(itemId: ItemId, data: Uint8Array): Promise<string> {
    await this.enforceSizeLimit()

    const id = nanoid()
    const entry: WalEntry = {
      id,
      itemId,
      data,
      createdAt: Date.now(),
    }

    try {
      await runStorageOperation(() => this.storage.setItem(id, entry))
    } catch (err) {
      if (isQuotaError(err)) {
        console.warn('[SyncWriteAheadLog] Quota exceeded on append. Attempting compaction...')
        const reduced = await this.compact()
        if (reduced === 0) {
          await this.pruneOldest(SyncWriteAheadLog.PRUNE_BATCH_SIZE)
        }
        // Retry once after emergency compaction/prune
        await runStorageOperation(() => this.storage.setItem(id, entry))
      } else {
        throw err
      }
    }

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
          isBatched: entry.isBatched === true,
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
