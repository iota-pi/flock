import { nanoid } from 'nanoid'
import type { ItemId } from '@vault/shared'
import { runStorageOperation } from '../utils/storageManager'
import { packBatchedMessages } from './utils/binaryFraming'
import { WalEntryQuery, type WalEntryDescriptor } from './WalEntryQuery'
import { SingleFlightGuard } from '../utils/SingleFlightGuard'
import type { WorkerInternalEventHub } from './SyncEventHub'
import { createAccountStore } from '../shared/createAccountStore'
import { SYNC_BATCH_SIZES } from '../shared/syncConfig'
import type { LocalCipher, SealedRecord } from './localEncryption/LocalCipher'
import { createLogger } from '../utils/logger'

const log = createLogger('SyncWriteAheadLog')

export interface WalEntry extends WalEntryDescriptor {
  id: string
  itemId: ItemId
  data: Uint8Array
  createdAt: number
  seq?: number
  isBatched?: boolean
  replaces?: string[]
}

/** A WAL entry as stored: in plaintext, or with `data` sealed and the descriptor left readable */
type StoredWalEntry = Omit<WalEntry, 'data'> & { data?: unknown, sealed?: SealedRecord }

export interface SyncWriteAheadLogOptions {
  /** Seals message bytes with the device storage key, in the sealed WAL store */
  cipher?: LocalCipher
}

export function toUint8Array(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) {
    return data
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data)
  }
  if (Array.isArray(data)) {
    return new Uint8Array(data)
  }
  if (data && typeof data === 'object') {
    const rawObj = data as Record<string | number, unknown>
    const length = typeof rawObj.length === 'number' && Number.isFinite(rawObj.length)
      ? Math.max(0, Math.floor(rawObj.length))
      : Object.keys(rawObj).length
    const result = new Uint8Array(length)
    for (let i = 0; i < length; i += 1) {
      const val = rawObj[i]
      if (typeof val === 'number') {
        result[i] = val
      }
    }
    return result
  }
  return new Uint8Array()
}

/** The highest seq and createdAt seen across stored entries */
interface SeqHighWaterMark {
  seq: number
  createdAt: number
}

function raiseHighWaterMark(mark: SeqHighWaterMark, entry: Pick<StoredWalEntry, 'seq' | 'createdAt'>): void {
  if (typeof entry.seq === 'number' && entry.seq > mark.seq) {
    mark.seq = entry.seq
  }
  if (typeof entry.createdAt === 'number' && entry.createdAt > mark.createdAt) {
    mark.createdAt = entry.createdAt
  }
}

const MAX_ENTRIES = SYNC_BATCH_SIZES.walMax
const PRUNE_BATCH_SIZE = SYNC_BATCH_SIZES.walPrune

export class SyncWriteAheadLog {
  public static readonly MAX_ENTRIES = MAX_ENTRIES

  private seqCounter = 0
  private lastCreatedAt = 0
  private isSeqInitialized = false
  private readonly initSeqGuard = new SingleFlightGuard<void>()

  private async ensureSeqInitialized(): Promise<void> {
    if (this.isSeqInitialized) return
    await this.initSeqGuard.run(async () => {
      if (this.isSeqInitialized) return
      const mark: SeqHighWaterMark = { seq: 0, createdAt: 0 }
      await this.storage.iterate<WalEntry, void>(entry => {
        if (entry) {
          raiseHighWaterMark(mark, entry)
        }
      })
      this.initializeSeq(mark)
    })
  }

  /** Continues seq and createdAt after the stored entries' high-water mark */
  private initializeSeq(mark: SeqHighWaterMark): void {
    if (mark.seq > this.seqCounter) {
      this.seqCounter = mark.seq
    }
    if (mark.createdAt > this.lastCreatedAt) {
      this.lastCreatedAt = mark.createdAt
    }
    this.isSeqInitialized = true
  }

  private storage: LocalForage
  private readonly internalEventHub: WorkerInternalEventHub

  public static getStorage(accountId: string): LocalForage {
    return createAccountStore('wal-entries', accountId)
  }

  public static getSealedStorage(accountId: string): LocalForage {
    return createAccountStore('wal-entries-sealed', accountId)
  }

  private readonly cipher?: LocalCipher

  constructor(
    public readonly accountId: string,
    internalEventHub: WorkerInternalEventHub,
    options: SyncWriteAheadLogOptions = {},
  ) {
    this.cipher = options.cipher
    this.storage = options.cipher
      ? SyncWriteAheadLog.getSealedStorage(accountId)
      : SyncWriteAheadLog.getStorage(accountId)
    this.internalEventHub = internalEventHub
  }

  /** Seals the entry's message bytes, outside any storage transaction */
  private async toStored(entry: WalEntry): Promise<StoredWalEntry> {
    if (!this.cipher) return entry
    const { data, ...descriptor } = entry
    const sealed = await this.cipher.seal({ store: 'wal', entryId: entry.id, itemId: entry.itemId }, data)
    return { ...descriptor, sealed }
  }

  /** Reads an entry's message bytes. Returns null when they can't be opened. */
  private async openData(entry: StoredWalEntry): Promise<Uint8Array | null> {
    if (!this.cipher) return entry.data ? toUint8Array(entry.data) : null
    try {
      return await this.cipher.open({ store: 'wal', entryId: entry.id, itemId: entry.itemId }, entry.sealed)
    } catch (error) {
      // The local doc holds the change, so a snapshot delivers it instead. The entry stays for pruning.
      log.error(`WAL entry ${entry.id} for ${entry.itemId} could not be decrypted`, error)
      this.internalEventHub.emit({ type: 'localDecryptionFailed', itemId: entry.itemId, error })
      this.internalEventHub.emit({ type: 'snapshotFallbackRequested', itemId: entry.itemId })
      return null
    }
  }

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

  isInFlight(entryId: string): boolean {
    return this.inFlightEntryIds.has(entryId)
  }

  /**
   * Create a query abstraction over a set of WAL entries, bound to this instance's in-flight state.
   */
  query<T extends WalEntryDescriptor>(entries: readonly T[]): WalEntryQuery<T> {
    return new WalEntryQuery(entries, this.inFlightEntryIds)
  }

  private readonly compactionGuard = new SingleFlightGuard<number>()

  /**
   * Compacts WAL by grouping entries by itemId and merging multiple entries
   * into a single batched entry per itemId.
   * Returns the number of entries reduced.
   */
  async compact(): Promise<number> {
    return this.compactionGuard.run(() => this.performCompact())
  }

  private async performCompact(): Promise<number> {
    const byItem = await this.readAll()
    let reducedCount = 0

    for (const [itemId, entries] of byItem.entries()) {
      const itemQuery = this.query(entries)

      // Skip compaction for items with active in-flight entries to prevent
      // fragmenting entries or splitting outbound delivery
      if (itemQuery.inFlight().length > 0) {
        continue
      }

      const availableEntries = itemQuery.available()

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
      const stored = await this.toStored(compactedEntry)
      await runStorageOperation(() => this.storage.setItem(newId, stored), { retryOnQuotaError: false })

      // Remove the old individual entries
      await this.remove(oldIds)

      reducedCount += availableEntries.length - 1
    }

    return reducedCount
  }

  private readonly pruningGuard = new SingleFlightGuard<void>()

  /**
   * Prunes oldest entries from WAL to keep size within limits or free space.
   */
  private async pruneOldest(count: number): Promise<void> {
    if (count <= 0) return
    return this.pruningGuard.run(() => this.performPruneOldest(count))
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

      // Prunable entries exclude superseded entries, in-flight entries, and any entries
      // belonging to items that have active in-flight entries (to prevent partial WAL history)
      const prunableEntries = query.prunableSorted(supersededIds)
      const entriesToPrune = prunableEntries.slice(0, count)
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
      // Remove all entries belonging to the pruned items to avoid partial change history in WAL.
      // Safety check: ensure in-flight entries are never removed even defensively.
      const toRemove = allEntries
        .filter(e => prunedItemSet.has(e.itemId) && !this.isInFlight(e.id))
        .map(e => e.id)

      if (toRemove.length > 0) {
        await this.remove(toRemove)
      }

      if (prunedItemIds.length > 0) {
        this.internalEventHub.emit({ type: 'walEntriesPruned', itemIds: prunedItemIds })
      }
    } catch (err) {
      log.error('Failed to prune oldest entries', err)
    }
  }

  private readonly enforceSizeLimitGuard = new SingleFlightGuard<void>()

  private async enforceSizeLimit(): Promise<void> {
    return this.enforceSizeLimitGuard.run(() => this.performEnforceSizeLimit())
  }

  private async performEnforceSizeLimit(): Promise<void> {
    try {
      const currentLength = await this.storage.length()
      if (currentLength >= MAX_ENTRIES) {
        log.warn(
          `WAL entry count (${currentLength}) reached threshold (${MAX_ENTRIES}). Compacting entries by item...`
        )
        // Step 1: Compact multiple entries per item
        await this.compact()

        const newLength = await this.storage.length()
        // Step 2: If still over limit (e.g. >2,000 unique items), prune oldest
        if (newLength >= MAX_ENTRIES) {
          const overflow = newLength - MAX_ENTRIES + PRUNE_BATCH_SIZE
          log.warn(
            `WAL still at ${newLength} entries after compaction. Pruning ${overflow} oldest entries.`
          )
          await this.pruneOldest(overflow)
        }
      }
    } catch (err) {
      log.error('Error checking WAL size limit', err)
    }
  }

  /**
   * Emergency compaction and pruning to recover storage space on QuotaExceededError.
   * Returns the number of entries reduced.
   */
  async handleQuotaExceeded(): Promise<number> {
    log.warn('Handling QuotaExceededError: compacting entries...')
    let reduced: number
    try {
      reduced = await this.compact()
      if (reduced === 0) {
        log.warn(`Compaction freed 0 entries. Emergency pruning oldest ${PRUNE_BATCH_SIZE} entries...`)
        await this.pruneOldest(PRUNE_BATCH_SIZE)
      }
    } catch (err) {
      log.error('Error during emergency compaction/prune:', err)
      throw err
    }
    return reduced
  }

  /**
   * Write a sync message to the WAL. Returns only after IndexedDB write completes.
   */
  async append(itemId: ItemId, data: Uint8Array): Promise<string> {
    await this.enforceSizeLimit()
    await this.ensureSeqInitialized()

    this.seqCounter += 1
    const id = nanoid()
    const now = Date.now()
    const createdAt = Math.max(now, this.lastCreatedAt)
    this.lastCreatedAt = createdAt

    const entry: WalEntry = {
      id,
      itemId,
      data,
      createdAt,
      seq: this.seqCounter,
    }

    const stored = await this.toStored(entry)
    await runStorageOperation(() => this.storage.setItem(id, stored))

    return id
  }

  /**
   * Read all pending WAL entries, grouped by item, ordered by creation time.
   * Reconciles any superseded entries left behind by interrupted compactions.
   */
  async readAll(): Promise<Map<ItemId, WalEntry[]>> {
    const storedEntries: StoredWalEntry[] = []
    const mark: SeqHighWaterMark = { seq: 0, createdAt: 0 }

    // localforage's iterate callback can't await, so entries are opened once it has finished
    await this.storage.iterate<StoredWalEntry, void>(entry => {
      if (entry && entry.id && entry.itemId && (this.cipher ? entry.sealed : entry.data)) {
        raiseHighWaterMark(mark, entry)
        storedEntries.push(entry)
      }
    })

    const openedData = await Promise.all(storedEntries.map(entry => this.openData(entry)))
    const rawEntries: WalEntry[] = []
    const supersededIds = new Set<string>()
    storedEntries.forEach((entry, index) => {
      const data = openedData[index]
      // An entry that can't be opened supersedes nothing, so the entries it replaced stay deliverable
      if (!data) return
      const validEntry: WalEntry = {
        id: entry.id,
        itemId: entry.itemId,
        data,
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
    })

    if (!this.isSeqInitialized) {
      this.initializeSeq(mark)
    }

    // If any superseded entries are still present in storage (e.g. crash during compaction),
    // purge them from storage immediately, excluding any in-flight entries to avoid deleting mid-push.
    if (supersededIds.size > 0) {
      const query = this.query(rawEntries)
      const idsToDelete = query.superseded(supersededIds).map(e => e.id)
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

    for (const [itemId, list] of result) {
      result.set(itemId, WalEntryQuery.sortByAge(list))
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

    await Promise.all(uniqueIds.map(id => runStorageOperation(() => this.storage.removeItem(id))))
  }

  /**
   * Copies entries from another WAL store, keeping their IDs, order and timestamps. Entries already
   * here are skipped, so copying again after an interruption is safe. Returns how many were added.
   */
  async importEntries(entries: readonly WalEntry[]): Promise<number> {
    const existing = new Set(await this.storage.keys())
    let imported = 0
    for (const entry of entries) {
      if (existing.has(entry.id)) continue
      const stored = await this.toStored(entry)
      await runStorageOperation(() => this.storage.setItem(entry.id, stored), { retryOnQuotaError: false })
      imported += 1
    }
    // The next append continues after the imported entries
    this.isSeqInitialized = false
    return imported
  }

  /**
   * Clear all entries (used on account switch or data clear).
   */
  async clear(): Promise<void> {
    this.inFlightEntryIds.clear()
    this.seqCounter = 0
    this.lastCreatedAt = 0
    this.isSeqInitialized = true
    await runStorageOperation(() => this.storage.clear())
  }
}
