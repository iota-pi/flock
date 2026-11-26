import type { VaultDoc } from '../shared/types'
import type { AutomergeDocStore, AutomergeIndexManager } from './docStore'
import type { SnapshotSchedule } from './SnapshotSchedule'
import type { SnapshotPusher } from './SnapshotPusher'
import type { ItemId, ManifestEntry } from '@vault/shared'
import type { SyncApiClient } from './SyncApiClient'
import type { StoreItemsOptions } from './ItemOperations'
import type { RecoveryManager } from './RecoveryManager'
import type { SyncSessionState } from './SyncSessionState'
import { checkAlive, isAbortError } from '../utils/abort'
import { isRequestFailure } from '../utils/errorClassifier'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'
import { calculateSyncDeltas, type QuarantinedItem, type SyncDeltas } from './calculateSyncDeltas'
import type { ManifestHydrator } from './ManifestHydrator'
import { findSnapshotsCoveredLocally } from './findSnapshotsCoveredLocally'
import { areHeadsEqual } from './utils/automerge'
import type { ItemSyncState } from './ItemSyncState'
import type { KeyProvider } from '../keys/Keyring'
import { createLogger } from '../utils/logger'

const log = createLogger('ManifestSyncManager')

const MANIFEST_SYNC_MIN_GAP_MS = SYNC_TIMEOUTS.manifestSyncMinGap
const MANIFEST_SYNC_INTERVAL_MS = SYNC_TIMEOUTS.manifestSyncInterval
const UPSTREAM_SNAPSHOT_DEBOUNCE_MS = SYNC_TIMEOUTS.upstreamSnapshotDebounce
const PULLED_CHANGES_GRACE_MS = SYNC_TIMEOUTS.pulledChangesGrace

export interface ManifestSyncManagerDeps {
  accountId: string
  /** Nothing starts once the session is shutting down */
  session: Pick<SyncSessionState, 'isShutdown'>
  docStore: AutomergeDocStore
  indexManager: AutomergeIndexManager
  /** Queues items owing the server a snapshot, and makes the queued ones due */
  snapshotSchedule: Pick<SnapshotSchedule, 'requestNow' | 'markItemDirty' | 'deleteDirtyItem'>
  /** Uploads the dirty items' snapshots before the manifest is fetched */
  snapshotPusher: Pick<SnapshotPusher, 'pushDue'>
  keys: KeyProvider
  recoveryManager: RecoveryManager
  apiClient: SyncApiClient
  /** Fetches the snapshots the manifest shows this device lacks, and merges them in */
  hydrator: Pick<ManifestHydrator, 'fetchAndHydrateRemoteItems'>
  storeItems: (items: VaultDoc[], options?: StoreItemsOptions) => Promise<void>
  /** Called with a server snapshot the local doc already holds, which wasn't fetched */
  onSnapshotCovered?: (itemId: ItemId, heads: string[]) => void
  /** Called once a sync has fetched the manifest and merged what it could */
  onManifestSynced?: () => void
  /** The items' base versions, which are dirty, and their unconfirmed pulls for snapshot coverage's S2 */
  itemSyncState: Pick<
    ItemSyncState,
    | 'listBaseVersions'
    | 'importBaseVersions'
    | 'listUnconfirmedPulls'
    | 'confirmPulledChanges'
    | 'dirtyCount'
    | 'isDirty'
    | 'listDirty'
  >
  /** Fetches the manifest on every sync, rather than at most every `manifestSyncMinGap` on a device that has items */
  fetchManifestEverySync?: boolean
  /** Moves settings that predate the settings document into it (see AccountSettings) */
  migrateLegacySettings?: () => Promise<void>
  /**
   * Called, without waiting for it, after a sync in which every item hydrated, or one skipped because
   * such a sync ran recently
   */
  onSyncedWithoutFailures?: () => void
}

export type SyncResult = { added: ItemId[], success: boolean }

/**
 * How strongly a manifest sync is wanted, weakest first. `due` is skipped within `manifestSyncMinGap`
 * of the last clean sync (unless the device has no items), `now` ignores that gap, and `force` also
 * fetches quarantined items and every item the server has a newer copy of.
 */
export type ManifestMode = 'due' | 'now' | 'force'

/** What a manifest sync came to, and whether it fetched the manifest (a skipped one didn't) */
export type ManifestPhaseResult = SyncResult & { fetchedManifest: boolean }

/** Where in the poll a manifest phase runs: before the log is read, or after */
export type ManifestStage = 'beforeRead' | 'afterRead'

/**
 * A manifest sync a caller asks the poll's manifest phase for, and how long the ask stays.
 *
 * - `until: 'served'` stays until a phase runs a sync at `mode` or stronger, whether or not that sync
 *   fetched the manifest (a `due` one may skip itself), or until the caller closes it.
 * - `until: 'fetched'` stays until such a sync fetches the manifest. A phase that should run one and
 *   can't fails the poll (rule 4). Only `now` and `force` syncs always fetch it, so only they may be
 *   asked this way: a `due` ask that skipped syncs never met would keep the poll due forever.
 */
export type ManifestAskOptions = {
  /**
   * Whether the sync must run before the log is read, rather than after. A sync that runs before
   * the read meets every ask it can, so it leaves nothing for after.
   */
  beforeRead?: boolean
  /** What the sync is for, which the error names when an ask until `fetched` can't be met */
  purpose?: string
  /** Called once a sync has met the ask */
  onMet?: (result: ManifestPhaseResult) => void
} & (
  | { mode: ManifestMode, until: 'served' }
  | { mode: Exclude<ManifestMode, 'due'>, until: 'fetched' }
)

/** An ask waiting on the poll's manifest phase */
export interface ManifestAsk {
  /** Whether no sync has met the ask yet, and it hasn't been closed */
  readonly isOpen: boolean
  /** Withdraws the ask, returning the result of the sync that met it, or a failure if none did */
  close(): ManifestPhaseResult
}

const MODE_STRENGTH: Record<ManifestMode, number> = { due: 0, now: 1, force: 2 }

function strongerMode(a: ManifestMode | undefined, b: ManifestMode): ManifestMode {
  return a !== undefined && MODE_STRENGTH[a] >= MODE_STRENGTH[b] ? a : b
}

const NOT_SYNCED: ManifestPhaseResult = { added: [], success: false, fetchedManifest: false }

class OpenAsk implements ManifestAsk {
  private result: ManifestPhaseResult | undefined

  constructor(readonly options: ManifestAskOptions, private readonly asks: Set<OpenAsk>) {}

  get isOpen(): boolean {
    return this.asks.has(this)
  }

  close(): ManifestPhaseResult {
    this.asks.delete(this)
    return this.result ?? NOT_SYNCED
  }

  /** Whether a sync at `mode` that came to `result` meets this ask */
  isMetBy(mode: ManifestMode, result: ManifestPhaseResult): boolean {
    if (MODE_STRENGTH[this.options.mode] > MODE_STRENGTH[mode]) return false
    return this.options.until === 'served' || result.fetchedManifest
  }

  meet(result: ManifestPhaseResult): void {
    this.asks.delete(this)
    this.result = result
    this.options.onMet?.(result)
  }
}

/**
 * Runs the manifest sync as a phase of the poll, which carries the poll's abort signal, so a sync
 * stops with the poll that runs it.
 */
export class ManifestSyncManager {
  private readonly isAlive = () => !this.deps.session.isShutdown

  private readonly asks = new Set<OpenAsk>()
  /** The persisted time of the last clean sync, once read */
  private lastCleanAt: number | undefined
  /** When a sync last fetched the manifest, clean or not, so one with item failures retries hourly */
  private lastAttemptAt = 0

  constructor(private readonly deps: ManifestSyncManagerDeps) {}

  /** Asks the poll's manifest phase for a sync, which stays asked for as `options.until` says */
  ask(options: ManifestAskOptions): ManifestAsk {
    const ask = new OpenAsk(options, this.asks)
    this.asks.add(ask)
    return ask
  }

  /**
   * When the poll's manifest phase next has work, for scheduling polls: now while a sync is asked for,
   * otherwise `manifestSyncMinGap` after the last clean sync or `manifestSyncInterval` after the last
   * one that fetched the manifest, whichever is later. Undefined once the session is shutting down,
   * and before the last clean sync's time has been read.
   */
  getDueAt(now = Date.now()): number | undefined {
    if (!this.isAlive()) return undefined
    if (this.asks.size > 0) return now
    return this.periodicDueAt
  }

  private get periodicDueAt(): number | undefined {
    if (this.lastCleanAt === undefined) return undefined
    return Math.max(this.lastCleanAt + MANIFEST_SYNC_MIN_GAP_MS, this.lastAttemptAt + MANIFEST_SYNC_INTERVAL_MS)
  }

  /**
   * One of the poll's manifest phases. Before the log is read, it runs a sync only if an ask must
   * run then; after, for any ask, or a `due` one if the periodic sync is due. A sync that runs takes
   * the strongest mode asked for, and meets the asks placed before it started that it satisfies
   * (`ManifestAskOptions`). Null means none ran. A manifest that can't be fetched throws, which fails
   * the poll (rule 4), and every ask stays. Items that fail to hydrate don't throw: they are left
   * for the next sync.
   */
  async runPhase(stage: ManifestStage, signal: AbortSignal): Promise<ManifestPhaseResult | null> {
    const asks = Array.from(this.asks)
    const joining = stage === 'afterRead' || asks.some(ask => ask.options.beforeRead) ? asks : []
    if (!this.isAlive()) {
      const mustFetch = joining.filter(ask => ask.options.until === 'fetched')
      if (mustFetch.length > 0) {
        const purposes = mustFetch.map(ask => ask.options.purpose ?? 'A manifest sync').join(', ')
        throw new Error(`${purposes} needs the manifest, which this session can't fetch now`)
      }
      return null
    }
    this.lastCleanAt ??= await this.deps.indexManager.getLastManifestSyncTime()
    checkAlive(signal, this.isAlive)

    let mode: ManifestMode | undefined
    for (const ask of joining) {
      mode = strongerMode(mode, ask.options.mode)
    }
    const periodicDueAt = this.periodicDueAt
    if (stage === 'afterRead' && mode === undefined && periodicDueAt !== undefined && Date.now() >= periodicDueAt) {
      mode = 'due'
    }
    if (mode === undefined) return null

    const result = await this.executeSync(mode, signal)
    for (const ask of joining) {
      if (ask.isOpen && ask.isMetBy(mode, result)) ask.meet(result)
    }
    return result
  }

  private shouldSkipSync(mode: ManifestMode, hasKnownItems: boolean, timeSinceLastSync: number): boolean {
    if (this.deps.fetchManifestEverySync) return false
    return mode === 'due' && hasKnownItems && timeSinceLastSync < MANIFEST_SYNC_MIN_GAP_MS
  }

  /** Throws if the manifest can't be fetched, so the poll fails and backs off (rule 4) */
  private async fetchRemoteManifest(signal: AbortSignal): Promise<ManifestEntry[]> {
    checkAlive(signal, this.isAlive)
    const manifestResponse = await this.deps.apiClient.fetchManifest({ account: this.deps.accountId }, { signal })
    this.lastAttemptAt = Date.now()
    return manifestResponse.manifest
  }

  private async collectLocalSyncState(signal: AbortSignal) {
    const tombstoneItemIds = await this.deps.indexManager.listTombstoneIds()
    const localVersionsMap = this.listLocalVersions()
    checkAlive(signal, this.isAlive)

    const quarantinedMap = new Map<ItemId, QuarantinedItem>()
    try {
      const recoveryEntries = await this.deps.recoveryManager.listRecoveryItems()
      checkAlive(signal, this.isAlive)
      for (const entry of recoveryEntries) {
        quarantinedMap.set(entry.itemId, { serverVersion: entry.serverVersion })
      }
    } catch (err) {
      if (signal.aborted || isAbortError(err)) throw err
      log.warn('Failed to read manual recovery entries', err)
    }

    return { tombstoneItemIds, quarantinedMap, localVersionsMap }
  }

  /** Each item's base version, and whether it's queued for a snapshot */
  private listLocalVersions(): Map<ItemId, { baseVersion: number; isDirty: boolean }> {
    const { itemSyncState } = this.deps
    const result = new Map<ItemId, { baseVersion: number; isDirty: boolean }>()
    for (const [itemId, baseVersion] of itemSyncState.listBaseVersions()) {
      result.set(itemId, { baseVersion, isDirty: itemSyncState.isDirty(itemId) })
    }
    for (const itemId of itemSyncState.listDirty()) {
      if (!result.has(itemId)) result.set(itemId, { baseVersion: 0, isDirty: true })
    }
    return result
  }

  private async checkGating(
    mode: ManifestMode,
    signal: AbortSignal,
  ): Promise<{ skip: boolean; hasKnownItems: boolean; knownItemIds: ItemId[] }> {
    checkAlive(signal, this.isAlive)
    const knownItemIds = await this.deps.indexManager.listItemIds()
    // Read once per session, at its first phase, and kept since
    const lastManifestSyncTime = this.lastCleanAt ?? 0

    const hasKnownItems = knownItemIds.length > 0
    const timeSinceLastSync = lastManifestSyncTime > 0 ? Date.now() - lastManifestSyncTime : Infinity
    const skip = this.shouldSkipSync(mode, hasKnownItems, timeSinceLastSync)

    return { skip, hasKnownItems, knownItemIds }
  }

  /**
   * Uploads every dirty item's snapshot through the snapshot phase's upload. The manifest sync is
   * itself a phase of the poll, so nothing else is uploading. A request that fails as a whole fails
   * the sync (rule 4); anything else is left to the snapshot phase, which uploads them again.
   */
  private async flushPendingSnapshotsSafely(signal: AbortSignal): Promise<void> {
    const { itemSyncState, snapshotSchedule, snapshotPusher } = this.deps
    if (itemSyncState.dirtyCount === 0) return
    try {
      // Not past a quota deferral, or every manifest sync of an account at its quota sends a batch to be refused
      snapshotSchedule.requestNow({ pastQuota: false })
      await snapshotPusher.pushDue(signal)
    } catch (flushErr) {
      if (signal.aborted || isAbortError(flushErr) || isRequestFailure(flushErr)) throw flushErr
      log.warn('Failed to flush pending snapshots before sync', flushErr)
    }
  }

  private async recordSyncCompletion(hasFailures: boolean): Promise<void> {
    if (!hasFailures) {
      const now = Date.now()
      await this.deps.indexManager.updateLastManifestSyncTime(now)
      this.lastCleanAt = now
    } else {
      log.warn(
        'Some batches or items failed to sync; lastManifestSyncTime not updated to allow retry',
      )
    }
  }

  private async executeSync(mode: ManifestMode, signal: AbortSignal): Promise<ManifestPhaseResult> {
    const force = mode === 'force'
    const gating = await this.checkGating(mode, signal)
    if (gating.skip) {
      // Only a sync without failures records the time that lets later syncs be skipped
      this.deps.onSyncedWithoutFailures?.()
      return { added: [], success: true, fetchedManifest: false }
    }

    // Flushed first so the manifest includes them; otherwise they look missing and are pushed again
    await this.flushPendingSnapshotsSafely(signal)
    checkAlive(signal, this.isAlive)

    const manifest = await this.fetchRemoteManifest(signal)
    checkAlive(signal, this.isAlive)

    const localState = await this.collectLocalSyncState(signal)
    checkAlive(signal, this.isAlive)

    if (!force) {
      await this.skipSnapshotsCoveredLocally(manifest, gating.knownItemIds, localState, signal)
      checkAlive(signal, this.isAlive)
    }

    // Step 1: Calculate sync deltas
    const deltas = calculateSyncDeltas({
      manifest,
      force,
      knownItemIds: gating.knownItemIds,
      tombstoneItemIds: localState.tombstoneItemIds,
      quarantinedMap: localState.quarantinedMap,
      localVersionsMap: localState.localVersionsMap,
    })

    // Step 2: Push local updates
    await this.pushLocalUpdates(deltas)
    checkAlive(signal, this.isAlive)

    let added: ItemId[] = []
    let hasFailures = false

    // Step 3: Fetch and hydrate remote items
    if (deltas.missingIds.length > 0) {
      const hydrationResult = await this.deps.hydrator.fetchAndHydrateRemoteItems(
        {
          missingIds: deltas.missingIds,
          manifest,
          knownSet: deltas.knownSet,
          tombstoneSet: deltas.tombstoneSet,
        },
        signal,
      )
      added = hydrationResult.added
      hasFailures = hydrationResult.hasFailures
      checkAlive(signal, this.isAlive)
    }

    this.deps.onManifestSynced?.()

    await this.migrateLegacySettings()
    checkAlive(signal, this.isAlive)

    await this.recordSyncCompletion(hasFailures)

    if (!hasFailures) {
      this.deps.onSyncedWithoutFailures?.()
    }

    return { added, success: !hasFailures, fetchedManifest: true }
  }

  private async pushLocalUpdates(deltas: SyncDeltas): Promise<void> {
    if (deltas.locallyTombstonedSnapshots.length > 0) {
      try {
        await this.deps.storeItems(deltas.locallyTombstonedSnapshots, { markDirty: false })
      } finally {
        for (const item of deltas.locallyTombstonedSnapshots) {
          this.deps.snapshotSchedule.deleteDirtyItem(item.id)
        }
      }
    }

    if (deltas.deletedVersionUpdates.length > 0) {
      for (const [id] of deltas.deletedVersionUpdates) {
        this.deps.snapshotSchedule.deleteDirtyItem(id)
      }
      // The tombstones must be stored before the base version says this device has them (rule 1)
      await this.deps.docStore.flushToStorage(deltas.locallyTombstonedSnapshots.map(item => item.id))
      await this.deps.itemSyncState.importBaseVersions(deltas.deletedVersionUpdates)
    }

    await this.reapplyLostDeletes(deltas)

    for (const id of deltas.upstreamIds) {
      this.deps.snapshotSchedule.markItemDirty(id, UPSTREAM_SNAPSHOT_DEBOUNCE_MS)
    }
  }

  /**
   * Deletes the docs of items the index has tombstoned but whose doc is live, which the upstream
   * deltas push because the server copy is live too. That happens when a crash lost the doc's
   * delete before the Repo saved it, on builds that tombstoned the index first. The tombstone is
   * terminal, so the delete stands. Without this the device would push a live snapshot on every
   * manifest sync, and the server copy would never be deleted.
   */
  private async reapplyLostDeletes(deltas: SyncDeltas): Promise<void> {
    const lostDeletes: VaultDoc[] = []
    for (const id of deltas.upstreamIds) {
      if (!deltas.tombstoneSet.has(id)) continue
      const item = await this.deps.docStore.getAutomergeItem(id)
      if (item && item.deleted !== true) {
        lostDeletes.push({ id, deleted: true })
      }
    }
    if (lostDeletes.length > 0) {
      log.warn('Deleting docs the index has tombstoned', { itemIds: lostDeletes.map(item => item.id) })
      await this.deps.storeItems(lostDeletes)
    }
  }

  /**
   * Raises `baseVersion` to the server's for items whose snapshot this device already has, so that
   * the deltas don't fetch them.
   *
   * A device that holds changes must upload them if nobody else does (rule S2 of snapshot coverage).
   * So an item whose doc holds this snapshot and more gets a new one, once the author of any pulled
   * changes has had its chance.
   */
  private async skipSnapshotsCoveredLocally(
    manifest: ManifestEntry[],
    knownItemIds: ItemId[],
    localState: Awaited<ReturnType<ManifestSyncManager['collectLocalSyncState']>>,
    signal: AbortSignal,
  ): Promise<void> {
    const unconfirmedPulls = this.deps.itemSyncState.listUnconfirmedPulls()
    const graceStart = Date.now() - PULLED_CHANGES_GRACE_MS
    const forgotten = this.uploadUncheckablePulls(manifest, knownItemIds, localState, unconfirmedPulls, graceStart)
    const found = await findSnapshotsCoveredLocally({
      manifest,
      activeItemIds: knownItemIds,
      tombstoneItemIds: localState.tombstoneItemIds,
      quarantinedMap: localState.quarantinedMap,
      localVersionsMap: localState.localVersionsMap,
      unconfirmedPulls,
      keys: this.deps.keys,
      docStore: this.deps.docStore,
      signal,
      isAlive: this.isAlive,
    })
    checkAlive(signal, this.isAlive)

    const covered = found.filter(snapshot => snapshot.isNewer)
    for (const { itemId, version } of covered) {
      const isDirty = localState.localVersionsMap.get(itemId)?.isDirty ?? false
      localState.localVersionsMap.set(itemId, { baseVersion: version, isDirty })
    }
    if (covered.length > 0) {
      // The doc may hold the snapshot only in memory, such as changes pulled moments ago. Saving an
      // unchanged doc is a no-op.
      await this.deps.docStore.flushToStorage(covered.map(({ itemId }) => itemId))
      await this.deps.itemSyncState.importBaseVersions(covered.map(({ itemId, version }) => [itemId, version]))
      for (const { itemId, heads } of covered) {
        this.deps.onSnapshotCovered?.(itemId, heads)
      }
      log.info(`Skipped fetching ${covered.length} snapshots this device already has`)
    }

    const confirmed: ItemId[] = [...forgotten]
    for (const { itemId, heads, docHeads, isNewer } of found) {
      if (areHeadsEqual(heads, docHeads)) {
        if (unconfirmedPulls.has(itemId)) confirmed.push(itemId)
      } else if (isNewer || (unconfirmedPulls.get(itemId) ?? Infinity) <= graceStart) {
        this.deps.snapshotSchedule.markItemDirty(itemId, UPSTREAM_SNAPSHOT_DEBOUNCE_MS)
      }
    }
    if (confirmed.length > 0) {
      await this.deps.itemSyncState.confirmPulledChanges(confirmed)
    }
  }

  /**
   * S2 for the unconfirmed pulls `findSnapshotsCoveredLocally` can't check. A deleted item never
   * gets another snapshot, so its record is dropped, which this returns. A snapshot without heads
   * (written before snapshots had them) can't show whether it holds the pulled changes, so once the
   * grace period is over the item is uploaded: the doc holds them, and the new snapshot's heads
   * confirm the record at the next manifest sync.
   */
  private uploadUncheckablePulls(
    manifest: ManifestEntry[],
    knownItemIds: ItemId[],
    localState: Awaited<ReturnType<ManifestSyncManager['collectLocalSyncState']>>,
    unconfirmedPulls: ReadonlyMap<ItemId, number>,
    graceStart: number,
  ): ItemId[] {
    if (unconfirmedPulls.size === 0) return []
    const known = new Set(knownItemIds)
    const tombstones = new Set(localState.tombstoneItemIds)
    const forgotten: ItemId[] = []
    for (const entry of manifest) {
      const firstSeenAt = unconfirmedPulls.get(entry.itemId)
      if (firstSeenAt === undefined) continue
      if (entry.isDeleted) {
        forgotten.push(entry.itemId)
      } else if (
        !entry.heads
        && firstSeenAt <= graceStart
        && known.has(entry.itemId)
        && !tombstones.has(entry.itemId)
        && !localState.quarantinedMap.has(entry.itemId)
      ) {
        this.deps.snapshotSchedule.markItemDirty(entry.itemId, UPSTREAM_SNAPSHOT_DEBOUNCE_MS)
      }
    }
    return forgotten
  }

  private async migrateLegacySettings() {
    if (!this.deps.migrateLegacySettings) return
    try {
      await this.deps.migrateLegacySettings()
    } catch (error) {
      log.warn('Legacy settings migration skipped (will retry on next sync):', error)
    }
  }
}
