import * as Automerge from '@automerge/automerge/slim'
import { mapWithConcurrency, type ItemId, type ManifestEntry } from '@vault/shared'
import type { KeyProvider } from '../keys/Keyring'
import type { AutomergeDocStore } from './docStore'
import type { RecoveryManager } from './RecoveryManager'
import type { ServerHeads } from './ServerHeads'
import { decryptSnapshotHeads } from './snapshotHeads'
import { SyncLogDatabase } from './stores/SyncLogDatabase'
import { getSyncMetadataStorage, SYNC_METADATA_KEYS } from './stores/syncMetadataStorage'
import { createPendingMark } from './ChangeOutbox'
import { MissingKeyError } from './utils/decryptWithKeyResolution'
import { areHeadsEqual } from './utils/automerge'
import { SYNC_LOG_STORES } from '../shared/syncLogStorage'
import { SYNC_BATCH_SIZES } from '../shared/syncConfig'
import { clearWriteAheadLog } from '../shared/writeAheadLogStorage'
import { checkAlive, isAbortError, untilAborted } from '../utils/abort'
import { errorMessage } from '../utils/errorMessage'
import { fireAndForget } from '../utils/fireAndForget'
import { SingleFlightGuard } from '../utils/SingleFlightGuard'
import { runStorageOperation } from '../utils/storageManager'
import { createLogger } from '../utils/logger'

const log = createLogger('FirstStart')

/**
 * Why an item's server heads aren't known yet. `awaitingHeads` waits for the manifest to say.
 * `awaitingSnapshot` waits for this device's own snapshot, for an item with none it can trust.
 */
export type FirstStartState = 'awaitingHeads' | 'awaitingSnapshot'

/** Holds only IDs, so it needs no seal */
interface FirstStartRecord {
  itemId: ItemId
  state: FirstStartState
}

/**
 * The local part of first start, which runs once per account on the device, under the local data
 * lock and before any component reads its state. Every item starts unresolved and pending, and the
 * old sync state goes: server heads can name changes only the old table held, which no device can
 * read now. The flag comes last, so an interrupted run repeats, and never runs again once it's set,
 * because a later tab would otherwise clear heads the leader has set.
 */
export async function runFirstStartLocalPart(accountId: string, listItemIds: () => Promise<ItemId[]>): Promise<void> {
  const storage = getSyncMetadataStorage(accountId)
  if (await storage.getItem<boolean>(SYNC_METADATA_KEYS.FIRST_START_RESET)) return

  const db = new SyncLogDatabase(accountId)
  try {
    const itemIds = await listItemIds()
    const records: FirstStartRecord[] = itemIds.map(itemId => ({ itemId, state: 'awaitingHeads' }))
    await db.put(SYNC_LOG_STORES.firstStart, ...records)
    await db.put(SYNC_LOG_STORES.outbox, ...itemIds.map(createPendingMark))
  } finally {
    await db.close()
  }
  await runStorageOperation(async () => {
    await storage.removeItem(SYNC_METADATA_KEYS.SYNCED_HEADS)
    await storage.removeItem(SYNC_METADATA_KEYS.CURSORS)
    await storage.setItem(SYNC_METADATA_KEYS.FIRST_START_RESET, true)
  })
}

export interface FirstStartDeps {
  accountId: string
  db: SyncLogDatabase
  keys: KeyProvider
  docStore: Pick<AutomergeDocStore, 'findHandle'>
  recoveryManager: Pick<RecoveryManager, 'listRecoveryItems'>
  serverHeads: ServerHeads
  /** Runs a manifest sync now, returning whether it fetched the manifest */
  syncManifest: (signal?: AbortSignal) => Promise<boolean>
  /** Pushes every pending item */
  pushPending: (signal?: AbortSignal) => Promise<void>
  /** The base version of an item, which says how far its doc has merged the server's snapshots */
  getBaseVersion: (itemId: ItemId) => number
  /** Asks for an item's snapshot */
  requestSnapshot: (itemId: ItemId) => void
  /** Whether a snapshot upload is waiting for the item */
  isDirty: (itemId: ItemId) => boolean
  /** Tells the puller the manifest sync that goes with catching up has run */
  onManifestSynced: () => void
}

/**
 * Moves a device onto the sync log, once per account. Nothing is copied from the old table: snapshots
 * carry the data across, and each device uploads what it has that they lack. The local part (see
 * `runFirstStartLocalPart`) holds the lock. This is the network part, which can wait indefinitely on
 * an offline device, so it holds none. The leader runs it before its first `pollLog`.
 *
 * An item with a record can't be pushed, because a push would send its whole history. Records don't
 * hold back polling or any other item: they resolve at every manifest sync and keyring update.
 */
export class FirstStart {
  private readonly records = new Map<ItemId, FirstStartState>()
  private isSynced = false
  /** Whether heads are resolved enough for pushes to go ahead */
  private isReadyToPush = false
  private latestManifest: ManifestEntry[] | null = null
  private hasTriedWalClear = false
  /** Why the network part last failed, cleared once it finishes */
  private lastError: string | null = null
  private readonly readyToPush = Promise.withResolvers<void>()
  private readonly networkPart = new SingleFlightGuard<void>()
  private readonly resolveGuard = new SingleFlightGuard<void>()

  constructor(private readonly deps: FirstStartDeps) {}

  private get storage(): LocalForage {
    return getSyncMetadataStorage(this.deps.accountId)
  }

  async load(): Promise<void> {
    const [records, isSynced] = await Promise.all([
      this.deps.db.getAll<FirstStartRecord>(SYNC_LOG_STORES.firstStart),
      this.storage.getItem<boolean>(SYNC_METADATA_KEYS.FIRST_START_SYNCED),
    ])
    this.records.clear()
    for (const { itemId, state } of records) {
      this.records.set(itemId, state)
    }
    if (isSynced) this.markSynced()
  }

  private markSynced(): void {
    this.isSynced = true
    this.lastError = null
    this.markReadyToPush()
  }

  private markReadyToPush(): void {
    this.isReadyToPush = true
    this.readyToPush.resolve()
  }

  stateOf(itemId: ItemId): FirstStartState | undefined {
    return this.records.get(itemId)
  }

  has(itemId: ItemId): boolean {
    return this.records.has(itemId)
  }

  get canPush(): boolean {
    return this.isReadyToPush
  }

  get synced(): boolean {
    return this.isSynced
  }

  /** Why the network part last failed, or null once it has finished */
  get error(): string | null {
    return this.lastError
  }

  /**
   * Resolves once pushes may go ahead, which is as soon as the network part's manifest sync has run,
   * or rejects if `signal` aborts first. It doesn't wait for the network part's push, which one item
   * the server keeps refusing could hold up for good.
   */
  async whenReadyToPush(signal?: AbortSignal): Promise<void> {
    await (signal ? untilAborted(this.readyToPush.promise, signal) : this.readyToPush.promise)
  }

  /** Runs the network part if it hasn't finished. Throws if it can't finish yet, and a later poll retries. */
  async ensureSynced(signal?: AbortSignal): Promise<void> {
    if (!this.isSynced) {
      try {
        await this.networkPart.run(() => this.runNetworkPart(signal))
      } catch (error) {
        if (!isAbortError(error)) this.lastError = errorMessage(error)
        throw error
      }
    }
    this.clearWalOnce()
  }

  private async runNetworkPart(signal?: AbortSignal): Promise<void> {
    if (!await this.deps.syncManifest(signal)) {
      throw new Error('First start needs the manifest, which could not be fetched')
    }
    checkAlive(signal, true)
    this.deps.onManifestSynced()

    this.markReadyToPush()
    await this.deps.pushPending(signal)
    checkAlive(signal, true)

    await runStorageOperation(() => this.storage.setItem(SYNC_METADATA_KEYS.FIRST_START_SYNCED, true))
    this.markSynced()
    log.info(`First start reconciled; ${this.records.size} items still wait for their server heads`)
  }

  /** Nothing reads the WAL now, so a failure is left for the leader's next start */
  private clearWalOnce(): void {
    if (this.hasTriedWalClear) return
    this.hasTriedWalClear = true
    fireAndForget(this.clearWal(), 'FirstStart:clearWal', error => {
      log.warn('Failed to clear the write-ahead log; it will be tried at the next start', error)
    })
  }

  private async clearWal(): Promise<void> {
    if (await this.storage.getItem<boolean>(SYNC_METADATA_KEYS.WAL_CLEARED)) return
    await clearWriteAheadLog(this.deps.accountId)
    await runStorageOperation(() => this.storage.setItem(SYNC_METADATA_KEYS.WAL_CLEARED, true))
  }

  /** Resolves what it can from a manifest sync, which has merged whatever it could first */
  async onManifestProcessed(manifest: ManifestEntry[]): Promise<void> {
    this.latestManifest = this.hasAwaitingHeads ? manifest : null
    await this.resolveAwaitingHeads(manifest)
    await this.requestAwaitedSnapshots()
  }

  /** A key that has arrived may unlock heads the last manifest carried */
  onKeyringUpdated(): void {
    if (!this.latestManifest) return
    fireAndForget(this.resolveAwaitingHeads(this.latestManifest), 'FirstStart:resolveAwaitingHeads')
  }

  private get hasAwaitingHeads(): boolean {
    return Array.from(this.records.values()).includes('awaitingHeads')
  }

  private async resolveAwaitingHeads(manifest: ManifestEntry[]): Promise<void> {
    if (!this.hasAwaitingHeads) return
    await this.resolveGuard.run(async () => {
      const manifestById = new Map(manifest.map(entry => [entry.itemId, entry]))
      const recoveryEntries = await this.deps.recoveryManager.listRecoveryItems()
      const quarantined = new Set(recoveryEntries.map(entry => entry.itemId))
      const itemIds = Array.from(this.records.entries())
        .filter(([itemId, state]) => state === 'awaitingHeads' && !quarantined.has(itemId))
        .map(([itemId]) => itemId)

      await mapWithConcurrency(itemIds, SYNC_BATCH_SIZES.hydrationConcurrency, async itemId => {
        await this.resolveItem(itemId, manifestById.get(itemId))
      })
      if (!this.hasAwaitingHeads) this.latestManifest = null
    })
  }

  /** The dirty flag that asked for these snapshots may not have survived a crash */
  private async requestAwaitedSnapshots(): Promise<void> {
    const awaited = Array.from(this.records.entries())
      .filter(([itemId, state]) => state === 'awaitingSnapshot' && !this.deps.isDirty(itemId))
      .map(([itemId]) => itemId)
    if (awaited.length === 0) return
    const recoveryEntries = await this.deps.recoveryManager.listRecoveryItems()
    const quarantined = new Set(recoveryEntries.map(entry => entry.itemId))
    for (const itemId of awaited) {
      if (!quarantined.has(itemId)) this.deps.requestSnapshot(itemId)
    }
  }

  private async resolveItem(itemId: ItemId, entry: ManifestEntry | undefined): Promise<void> {
    if (entry?.isDeleted) {
      await this.removeRecord(itemId)
      return
    }
    if (!entry) {
      await this.awaitSnapshot(itemId)
      return
    }

    let heads: string[] | null = null
    if (entry.heads) {
      try {
        heads = await decryptSnapshotHeads(this.deps.keys, itemId, entry.heads, { skipWait: true })
      } catch (error) {
        if (error instanceof MissingKeyError) return
        log.warn(`Snapshot heads of ${itemId} can't be read`, error)
      }
    }

    if (!heads) {
      // Uploading before the doc has merged this snapshot would replace something it lacks
      if (this.deps.getBaseVersion(itemId) >= (entry.version ?? 1)) {
        await this.awaitSnapshot(itemId)
      }
      return
    }

    const handle = await this.deps.docStore.findHandle(itemId)
    const doc = handle?.isReady() ? handle.doc() : undefined
    if (!doc || !Automerge.hasHeads(doc, heads)) return

    this.deps.serverHeads.set(itemId, heads)
    await this.removeRecord(itemId)
    // A doc with more than the snapshot is pushed as normal, and its snapshot has to catch up
    if (!areHeadsEqual(Automerge.getHeads(doc), heads) || this.deps.isDirty(itemId)) {
      this.deps.requestSnapshot(itemId)
    }
  }

  private async awaitSnapshot(itemId: ItemId): Promise<void> {
    this.records.set(itemId, 'awaitingSnapshot')
    await this.deps.db.put(SYNC_LOG_STORES.firstStart, { itemId, state: 'awaitingSnapshot' })
    this.deps.requestSnapshot(itemId)
  }

  private async removeRecord(itemId: ItemId): Promise<void> {
    this.records.delete(itemId)
    await this.deps.db.delete(SYNC_LOG_STORES.firstStart, itemId)
  }

  /** A confirmed snapshot of an `awaitingSnapshot` item puts the server at its heads. A tombstone has none. */
  async onSnapshotConfirmed(itemId: ItemId, heads: string[] | undefined): Promise<void> {
    if (this.records.get(itemId) !== 'awaitingSnapshot') return
    if (heads && heads.length > 0) {
      this.deps.serverHeads.set(itemId, heads)
    }
    await this.removeRecord(itemId)
  }
}
