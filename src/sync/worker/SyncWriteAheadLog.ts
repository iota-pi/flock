import localforage from 'localforage'
import { nanoid } from 'nanoid'
import type { ItemId } from 'src/shared/schemas/items'
import { runStorageOperation } from '../../utils/storageManager'
import { isQuotaError } from '../../utils/storageQuota'
import { packBatchedMessages, type BatchableMessage } from './utils/binaryFraming'
import { WalEntryQuery, type WalEntryDescriptor } from './WalEntryQuery'

export { packBatchedMessages, type BatchableMessage, WalEntryQuery, type WalEntryDescriptor }

export interface WalEntry extends WalEntryDescriptor {
  id: string
  itemId: ItemId
  data: Uint8Array
  createdAt: number
  seq?: number
  isBatched?: boolean
  replaces?: string[]
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
  SyncWriteAheadLog.resetSeqCounterForTesting()
}

export class SyncWriteAheadLog {
  public static readonly MAX_ENTRIES = 2000
  private static readonly PRUNE_BATCH_SIZE = 100
  private static seqCounter = 0

  public static resetSeqCounterForTesting(): void {
    SyncWriteAheadLog.seqCounter = 0
  }

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

  constructor(public readonly accountId: string) {
    this.storage = SyncWriteAheadLog.getStorage(accountId)
  }

  public onEntriesPruned: ((prunedItemIds: ItemId[]) => void) | null = null

  private readonly inFlightEntryIds = new Set<string>()

  markInFlight(entryIds: string[]): void {
    if (!entryIds || entryIds.length === 0) return
    for (const id of entryIds) {
      if (typeof id === 'string' && id.length > 0) {
        this.inFlightEntryIds.add(id)
      }
    }
  }

  unmarkInFlight(entryIds: string[]): void {
    if (!entryIds || entryIds.length === 0) return
    for (const id of entryIds) {
      this.inFlightEntryIds.delete(id)
    }
  }

  clearInFlight(): void {
    this.inFlightEntryIds.clear()
  }

  isInFlight(entryId: string): boolean {
    return this.inFlightEntryIds.has(entryId)
  }

  /**
   * Create a query abstraction over a set of WAL entries, bound to this instance's in-flight state.
   */
  query<T extends WalEntryDescriptor>(entries: readonly T[]): WalEntryQuery<T> {
    return new WalEntryQuery(entries, this.inFlightEntryIds)
  }

  private compactionPromise: Promise<number> | null = null

  /**
   * Compacts WAL by grouping entries by itemId and merging multiple entries
   * into a single batched entry per itemId.
   * Returns the number of entries reduced.
   */
  async compact(): Promise<number> {
    if (this.compactionPromise) {
      return this.compactionPromise
    }
    this.compactionPromise = this.performCompact().finally(() => {
      this.compactionPromise = null
    })
    return this.compactionPromise
  }

  private async performCompact(): Promise<number> {
    const byItem = await this.readAll()
    let reducedCount = 0

    for (const [itemId, entries] of byItem.entries()) {
      // Exclude entries that are currently in-flight from compaction to prevent race conditions with active push
      const availableEntries = this.query(entries).available()

      if (availableEntries.length <= 1) continue

      const combinedData = packBatchedMessages(availableEntries)
      const latestCreatedAt = Math.max(...availableEntries.map(e => e.createdAt || 0))
      const latestSeq = Math.max(...availableEntries.map(e => e.seq ?? 0))
      const newId = nanoid()

      // Track all old IDs being replaced (including transitive replacements)
      const oldIds = Array.from(
        new Set(availableEntries.flatMap(e => [e.id, ...(e.replaces || [])]))
      )

      const compactedEntry: WalEntry = {
        id: newId,
        itemId,
        data: combinedData,
        createdAt: latestCreatedAt,
        seq: latestSeq,
        isBatched: true,
        replaces: oldIds,
      }

      // Save new compacted entry first
      await runStorageOperation(() => this.storage.setItem(newId, compactedEntry))

      // Remove the old individual entries
      await this.remove(oldIds)

      reducedCount += availableEntries.length - 1
    }

    return reducedCount
  }

  private pruningPromise: Promise<void> | null = null

  /**
   * Prunes oldest entries from WAL to keep size within limits or free space.
   */
  private async pruneOldest(count: number): Promise<void> {
    if (count <= 0) return
    if (this.pruningPromise) {
      return this.pruningPromise
    }
    this.pruningPromise = this.performPruneOldest(count).finally(() => {
      this.pruningPromise = null
    })
    return this.pruningPromise
  }

  private async performPruneOldest(count: number): Promise<void> {
    try {
      const allEntries: { id: string; itemId: ItemId; createdAt: number; seq: number }[] = []
      const supersededIds = new Set<string>()

      await this.storage.iterate<WalEntry, void>(entry => {
        if (entry && entry.id) {
          allEntries.push({
            id: entry.id,
            itemId: entry.itemId,
            createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : 0,
            seq: typeof entry.seq === 'number' ? entry.seq : 0,
          })
          if (Array.isArray(entry.replaces)) {
            for (const oldId of entry.replaces) {
              if (typeof oldId === 'string') {
                supersededIds.add(oldId)
              }
            }
          }
        }
      })

      const query = this.query(allEntries)

      // Clean up superseded entries first, excluding any in-flight entries
      const supersededInStorage = query.superseded(supersededIds).map(e => e.id)
      if (supersededInStorage.length > 0) {
        await this.remove(supersededInStorage)
      }

      // Valid entries exclude both superseded and currently in-flight entries, sorted chronologically
      const validEntries = query.validSorted(supersededIds)
      const entriesToPrune = validEntries.slice(0, count)
      if (entriesToPrune.length === 0) {
        return
      }

      const prunedItemIds = Array.from(
        new Set(
          entriesToPrune
            .map(e => e.itemId)
            .filter((id): id is ItemId => typeof id === 'string' && id.length > 0)
        )
      )

      const prunedItemSet = new Set(prunedItemIds)
      // Remove all entries belonging to the pruned items to avoid partial change history in WAL
      const toRemove = validEntries
        .filter(e => prunedItemSet.has(e.itemId))
        .map(e => e.id)

      if (toRemove.length > 0) {
        await this.remove(toRemove)
      }

      if (prunedItemIds.length > 0 && this.onEntriesPruned) {
        try {
          this.onEntriesPruned(prunedItemIds)
        } catch (cbErr) {
          console.error('[SyncWriteAheadLog] Error in onEntriesPruned callback', cbErr)
        }
      }
    } catch (err) {
      console.error('[SyncWriteAheadLog] Failed to prune oldest entries', err)
    }
  }

  private enforceSizeLimitPromise: Promise<void> | null = null

  private async enforceSizeLimit(): Promise<void> {
    if (this.enforceSizeLimitPromise) {
      return this.enforceSizeLimitPromise
    }
    this.enforceSizeLimitPromise = this.performEnforceSizeLimit().finally(() => {
      this.enforceSizeLimitPromise = null
    })
    return this.enforceSizeLimitPromise
  }

  private async performEnforceSizeLimit(): Promise<void> {
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

    SyncWriteAheadLog.seqCounter += 1
    const id = nanoid()
    const entry: WalEntry = {
      id,
      itemId,
      data,
      createdAt: Date.now(),
      seq: SyncWriteAheadLog.seqCounter,
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
   * Reconciles any superseded entries left behind by interrupted compactions.
   */
  async readAll(): Promise<Map<ItemId, WalEntry[]>> {
    const rawEntries: WalEntry[] = []
    const supersededIds = new Set<string>()

    await this.storage.iterate<WalEntry, void>(entry => {
      if (entry && entry.id && entry.itemId && entry.data) {
        const normalizedData = toUint8Array(entry.data)
        const validEntry: WalEntry = {
          id: entry.id,
          itemId: entry.itemId,
          data: normalizedData,
          createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : 0,
          seq: typeof entry.seq === 'number' ? entry.seq : 0,
          isBatched: entry.isBatched === true,
          replaces: Array.isArray(entry.replaces)
            ? entry.replaces.filter((r): r is string => typeof r === 'string' && r.length > 0 && r !== entry.id)
            : undefined,
        }
        rawEntries.push(validEntry)
        if (validEntry.replaces) {
          for (const oldId of validEntry.replaces) {
            supersededIds.add(oldId)
          }
        }
      }
    })

    // If any superseded entries are still present in storage (e.g. crash during compaction),
    // purge them from storage immediately.
    if (supersededIds.size > 0) {
      const idsToDelete = rawEntries
        .filter(e => supersededIds.has(e.id))
        .map(e => e.id)
      if (idsToDelete.length > 0) {
        await this.remove(idsToDelete)
      }
    }

    const result = new Map<ItemId, WalEntry[]>()
    for (const entry of rawEntries) {
      if (supersededIds.has(entry.id)) {
        continue
      }
      const list = result.get(entry.itemId) ?? []
      list.push(entry)
      result.set(entry.itemId, list)
    }

    for (const list of result.values()) {
      list.sort((a, b) => (a.createdAt - b.createdAt) || ((a.seq ?? 0) - (b.seq ?? 0)))
    }

    return result
  }

  /**
   * Remove specific entries by ID after successful network send.
   */
  async remove(entryIds: string[]): Promise<void> {
    if (!entryIds || entryIds.length === 0) return
    const uniqueIds = Array.from(new Set(entryIds.filter((id): id is string => typeof id === 'string' && id.length > 0)))
    if (uniqueIds.length === 0) return

    for (const id of uniqueIds) {
      this.inFlightEntryIds.delete(id)
    }

    await Promise.all(uniqueIds.map(id => this.storage.removeItem(id)))
  }

  /**
   * Clear all entries (used on account switch or data clear).
   */
  async clear(): Promise<void> {
    this.inFlightEntryIds.clear()
    await this.storage.clear()
  }
}
