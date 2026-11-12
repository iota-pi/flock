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
import type { ManualRecoveryKind } from '../shared/manualRecoveryStore'
import { FIRST_START_MAX_ATTEMPTS, SYNC_BATCH_SIZES, SYNC_TIMEOUTS } from '../shared/syncConfig'
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

/** Holds only IDs and counters, so it needs no seal */
interface FirstStartRecord {
  itemId: ItemId
  state: FirstStartState
  /** Tries made at resolving the item in this state, toward quarantining it */
  attempts?: number
  /** When the item may be tried again */
  retryAt?: number
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
  recoveryManager: Pick<RecoveryManager, 'listRecoveryItems' | 'quarantine'>
  serverHeads: ServerHeads
  /** Runs a manifest sync now, returning whether it fetched the manifest */
  syncManifest: (signal?: AbortSignal) => Promise<boolean>
  /** Fetches and merges the items' snapshots, whatever their base versions */
  fetchSnapshots: (itemIds: ItemId[], signal?: AbortSignal) => Promise<void>
  /** Asks the main thread for a key version the heads need */
  onKeyVersionMissing?: (kver: string) => void
  /** Called when `runDue` has work, so the leader polls soon */
  onWorkDue?: () => void
  now?: () => number
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
 *
 * Its pending mark stays while it waits, so an item that never resolves would wait for good. Each
 * way an item can get stuck is retried a few times, spaced out (`FIRST_START_MAX_ATTEMPTS`), and
 * then quarantined, which shows it in manual recovery instead of as waiting to sync.
 */
export class FirstStart {
  private readonly records = new Map<ItemId, FirstStartRecord>()
  /** Items whose doc lacks heads manifest sync thinks it has merged, to fetch at the next poll */
  private readonly forceFetch = new Set<ItemId>()
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
    for (const record of records) {
      this.records.set(record.itemId, record)
    }
    if (isSynced) this.markSynced()
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
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
    return this.records.get(itemId)?.state
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
    await this.retryAwaitedSnapshots()
    if (this.forceFetch.size > 0) this.deps.onWorkDue?.()
  }

  /** A key that has arrived may unlock heads the last manifest carried */
  onKeyringUpdated(): void {
    if (!this.latestManifest) return
    fireAndForget(this.resolveAwaitingHeads(this.latestManifest), 'FirstStart:resolveAwaitingHeads')
  }

  /**
   * Fetches the snapshots of items whose docs lack heads that manifest sync believes they've merged,
   * so it would never fetch them itself, then resolves them. The leader's poll runs this.
   */
  async runDue(signal?: AbortSignal): Promise<void> {
    const itemIds = Array.from(this.forceFetch).filter(itemId => this.stateOf(itemId) === 'awaitingHeads')
    this.forceFetch.clear()
    if (itemIds.length === 0) return
    log.info(`Fetching ${itemIds.length} snapshots whose heads first start is waiting for`)
    await this.deps.fetchSnapshots(itemIds, signal)
    checkAlive(signal, true)
    if (this.latestManifest) await this.resolveAwaitingHeads(this.latestManifest)
  }

  private get hasAwaitingHeads(): boolean {
    return Array.from(this.records.values()).some(record => record.state === 'awaitingHeads')
  }

  private async listQuarantined(): Promise<Set<ItemId>> {
    const recoveryEntries = await this.deps.recoveryManager.listRecoveryItems()
    return new Set(recoveryEntries.map(entry => entry.itemId))
  }

  private async resolveAwaitingHeads(manifest: ManifestEntry[]): Promise<void> {
    if (!this.hasAwaitingHeads) return
    await this.resolveGuard.run(async () => {
      const manifestById = new Map(manifest.map(entry => [entry.itemId, entry]))
      const quarantined = await this.listQuarantined()
      const itemIds = Array.from(this.records.values())
        .filter(record => record.state === 'awaitingHeads' && !quarantined.has(record.itemId))
        .map(record => record.itemId)

      await mapWithConcurrency(itemIds, SYNC_BATCH_SIZES.hydrationConcurrency, async itemId => {
        await this.resolveItem(itemId, manifestById.get(itemId))
      })
      if (!this.hasAwaitingHeads) this.latestManifest = null
    })
  }

  /**
   * Asks again for the snapshots `awaitingSnapshot` items wait for, since the dirty flag that asked
   * may not have survived a crash, and quarantines an item that has waited through every try
   */
  private async retryAwaitedSnapshots(): Promise<void> {
    const awaited = Array.from(this.records.values()).filter(record => record.state === 'awaitingSnapshot')
    if (awaited.length === 0) return
    const quarantined = await this.listQuarantined()
    for (const { itemId } of awaited) {
      if (quarantined.has(itemId)) continue
      await this.retryOrQuarantine(itemId, 'snapshotFailure', 'This device\'s snapshot of the item was never stored', () => {
        if (!this.deps.isDirty(itemId)) this.deps.requestSnapshot(itemId)
      })
    }
  }

  private async resolveItem(itemId: ItemId, entry: ManifestEntry | undefined): Promise<void> {
    if (entry?.isDeleted) {
      await this.removeRecord(itemId)
      // Its whole history would otherwise be pushed, for an item nothing can change now
      await this.deps.db.delete(SYNC_LOG_STORES.outbox, itemId)
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
        if (error instanceof MissingKeyError) {
          const { kver } = error
          await this.retryOrQuarantine(itemId, 'unknown', `Key version ${kver} for the item's heads never arrived`, () => {
            this.deps.onKeyVersionMissing?.(kver)
          })
          return
        }
        log.warn(`Snapshot heads of ${itemId} can't be read`, error)
      }
    }

    const baseVersion = this.deps.getBaseVersion(itemId)
    const version = entry.version ?? 1
    if (!heads) {
      // Uploading before the doc has merged this snapshot would replace something it lacks
      if (baseVersion >= version) {
        await this.awaitSnapshot(itemId)
      }
      return
    }

    const handle = await this.deps.docStore.findHandle(itemId)
    const doc = handle?.isReady() ? handle.doc() : undefined
    if (!doc || !Automerge.hasHeads(doc, heads)) {
      // Below the server's version, manifest sync fetches the snapshot. At or above it, manifest sync
      // takes the snapshot as merged and never fetches it, so it's fetched here.
      if (baseVersion >= version) {
        await this.retryOrQuarantine(itemId, 'unknown', 'The item never received the changes the server\'s snapshot holds', () => {
          this.forceFetch.add(itemId)
        })
      }
      return
    }

    this.deps.serverHeads.set(itemId, heads)
    await this.removeRecord(itemId)
    // A doc with more than the snapshot is pushed as normal, and its snapshot has to catch up
    if (!areHeadsEqual(Automerge.getHeads(doc), heads) || this.deps.isDirty(itemId)) {
      this.deps.requestSnapshot(itemId)
    }
  }

  /**
   * Makes another try at an item if one is due, counting it, or quarantines the item once it has had
   * every try. A quarantined item gets every try again once recovery releases it.
   */
  private async retryOrQuarantine(
    itemId: ItemId,
    kind: ManualRecoveryKind,
    reason: string,
    retry: () => void,
  ): Promise<void> {
    const record = this.records.get(itemId)
    if (!record) return
    const now = this.now()
    if ((record.retryAt ?? 0) > now) return

    const attempts = record.attempts ?? 0
    if (attempts >= FIRST_START_MAX_ATTEMPTS) {
      log.warn(`First start couldn't resolve ${itemId} after ${attempts} tries; quarantining it`)
      await this.deps.recoveryManager.quarantine(itemId, kind, reason)
      await this.saveRecord({ itemId, state: record.state })
      return
    }
    await this.saveRecord({
      itemId,
      state: record.state,
      attempts: attempts + 1,
      retryAt: now + SYNC_TIMEOUTS.firstStartRetryGap,
    })
    retry()
  }

  /** Asks for this device's snapshot, which is the first try at an `awaitingSnapshot` item */
  private async awaitSnapshot(itemId: ItemId): Promise<void> {
    await this.saveRecord({
      itemId,
      state: 'awaitingSnapshot',
      attempts: 1,
      retryAt: this.now() + SYNC_TIMEOUTS.firstStartRetryGap,
    })
    this.deps.requestSnapshot(itemId)
  }

  private async saveRecord(record: FirstStartRecord): Promise<void> {
    this.records.set(record.itemId, record)
    await this.deps.db.put(SYNC_LOG_STORES.firstStart, record)
  }

  private async removeRecord(itemId: ItemId): Promise<void> {
    this.records.delete(itemId)
    this.forceFetch.delete(itemId)
    await this.deps.db.delete(SYNC_LOG_STORES.firstStart, itemId)
  }

  /** A confirmed snapshot of an `awaitingSnapshot` item puts the server at its heads. A tombstone has none. */
  async onSnapshotConfirmed(itemId: ItemId, heads: string[] | undefined): Promise<void> {
    if (this.stateOf(itemId) !== 'awaitingSnapshot') return
    if (heads && heads.length > 0) {
      this.deps.serverHeads.set(itemId, heads)
    }
    await this.removeRecord(itemId)
  }
}
