import { nanoid } from 'nanoid'
import type { ItemId } from '@vault/shared'
import { runStorageOperation } from '../utils/storageManager'
import { SingleFlightGuard } from '../utils/SingleFlightGuard'
import type { WorkerInternalEventHub } from './SyncEventHub'
import { createAccountStore } from '../shared/createAccountStore'
import { SYNC_BATCH_SIZES } from '../shared/syncConfig'
import type { LocalCipher, SealedRecord } from './localEncryption/LocalCipher'
import { createLogger } from '../utils/logger'

const log = createLogger('SyncWriteAheadLog')

export interface WalEntry {
  id: string
  itemId: ItemId
  data: Uint8Array
  createdAt: number
  seq?: number
  /** Set by WAL compaction in older versions: `data` is a batch of messages packed by packBatchedMessages */
  isBatched?: boolean
  /** Set by WAL compaction in older versions: the IDs of the entries this batched entry superseded */
  replaces?: string[]
}

/** The fields that filter and order WAL entries, which stay readable when `data` is sealed */
type WalEntrySummary = Pick<WalEntry, 'id' | 'itemId' | 'createdAt' | 'seq'>

/** Oldest first by `createdAt`, then `seq`. Returns a new array. */
function sortByAge<T extends WalEntrySummary>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => (a.createdAt - b.createdAt) || ((a.seq ?? 0) - (b.seq ?? 0)))
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

  /**
   * Entries whose message bytes couldn't be opened, already reported. `readAll` runs on every poll,
   * so each one is reported once per instance rather than on every read.
   */
  private readonly unreadableEntryIds = new Set<string>()

  /** Reads an entry's message bytes. Returns null when they can't be opened. */
  private async openData(entry: StoredWalEntry): Promise<Uint8Array | null> {
    if (!this.cipher) return entry.data ? toUint8Array(entry.data) : null
    try {
      return await this.cipher.open({ store: 'wal', entryId: entry.id, itemId: entry.itemId }, entry.sealed)
    } catch (error) {
      // The local doc holds the change, so a snapshot delivers it instead. The entry stays for pruning.
      // Only this WAL record is unreadable, not the document, so the item isn't quarantined as
      // `localDecryption`: that would offer to discard a healthy local copy.
      if (!this.unreadableEntryIds.has(entry.id)) {
        this.unreadableEntryIds.add(entry.id)
        log.error(`WAL entry ${entry.id} for ${entry.itemId} could not be decrypted`, error)
        this.internalEventHub.emit({ type: 'snapshotFallbackRequested', itemId: entry.itemId })
      }
      return null
    }
  }

  /** Forgets reported unreadable entries that are no longer stored */
  private retainUnreadableEntryIds(storedIds: ReadonlySet<string>): void {
    for (const id of this.unreadableEntryIds) {
      if (!storedIds.has(id)) {
        this.unreadableEntryIds.delete(id)
      }
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

  /** Entries in `supersededIds` that aren't in flight */
  private supersededEntries<T extends WalEntrySummary>(entries: readonly T[], supersededIds: ReadonlySet<string>): T[] {
    return entries.filter(e => supersededIds.has(e.id) && !this.inFlightEntryIds.has(e.id))
  }

  /**
   * Entries that are neither superseded nor in flight, oldest first. Items with an entry in flight
   * are left out entirely, so pruning never leaves an item with a partial WAL history.
   */
  private prunableEntries<T extends WalEntrySummary>(entries: readonly T[], supersededIds: ReadonlySet<string>): T[] {
    const inFlightItemIds = new Set<string>()
    for (const entry of entries) {
      if (entry.itemId && this.inFlightEntryIds.has(entry.id)) {
        inFlightItemIds.add(entry.itemId)
      }
    }
    return sortByAge(entries.filter(e =>
      !supersededIds.has(e.id) && !this.inFlightEntryIds.has(e.id) && !(e.itemId && inFlightItemIds.has(e.itemId))
    ))
  }

  private readonly pruningGuard = new SingleFlightGuard<number>()

  /**
   * Prunes oldest entries from WAL to keep size within limits or free space.
   * Returns the number of entries removed.
   */
  private async pruneOldest(count: number): Promise<number> {
    if (count <= 0) return 0
    return this.pruningGuard.run(() => this.performPruneOldest(count))
  }

  private async performPruneOldest(count: number): Promise<number> {
    try {
      const allEntries: WalEntrySummary[] = []
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

      // Clean up entries superseded by batched entries that older versions' compaction left behind,
      // excluding any in-flight entries
      const supersededInStorage = this.supersededEntries(allEntries, supersededIds).map(e => e.id)
      if (supersededInStorage.length > 0) {
        await this.remove(supersededInStorage)
      }

      // Prunable entries exclude superseded entries, in-flight entries, and any entries
      // belonging to items that have active in-flight entries (to prevent partial WAL history)
      const prunableEntries = this.prunableEntries(allEntries, supersededIds)
      const entriesToPrune = prunableEntries.slice(0, count)
      if (entriesToPrune.length === 0) {
        return supersededInStorage.length
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
      return supersededInStorage.length + toRemove.length
    } catch (err) {
      log.error('Failed to prune oldest entries', err)
      return 0
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
        const overflow = currentLength - MAX_ENTRIES + PRUNE_BATCH_SIZE
        log.warn(
          `WAL entry count (${currentLength}) reached threshold (${MAX_ENTRIES}). Pruning ${overflow} oldest entries.`
        )
        await this.pruneOldest(overflow)
      }
    } catch (err) {
      log.error('Error checking WAL size limit', err)
    }
  }

  /**
   * Emergency pruning to recover storage space on QuotaExceededError. Pruned items fall back to
   * snapshot-only sync. Returns the number of entries removed.
   */
  async handleQuotaExceeded(): Promise<number> {
    log.warn(`Handling QuotaExceededError: pruning oldest ${PRUNE_BATCH_SIZE} entries...`)
    return this.pruneOldest(PRUNE_BATCH_SIZE)
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
   * Purges entries superseded by a batched entry, which older versions' compaction could leave behind.
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

    this.retainUnreadableEntryIds(new Set(storedEntries.map(entry => entry.id)))
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

    // If any superseded entries are still present in storage (an older version crashed mid-compaction),
    // purge them from storage immediately, excluding any in-flight entries to avoid deleting mid-push.
    if (supersededIds.size > 0) {
      const idsToDelete = this.supersededEntries(rawEntries, supersededIds).map(e => e.id)
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
      result.set(itemId, sortByAge(list))
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
      this.unreadableEntryIds.delete(id)
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
    this.unreadableEntryIds.clear()
    this.seqCounter = 0
    this.lastCreatedAt = 0
    this.isSeqInitialized = true
    await runStorageOperation(() => this.storage.clear())
  }
}
