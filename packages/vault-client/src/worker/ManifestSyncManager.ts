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
import type { ManifestDemand, ManifestDemands } from './ManifestDemands'
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
  /** The syncs other components demand, which a phase meets once it fetches the manifest */
  demands: ManifestDemands
  /** Fetches the snapshots the manifest shows this device lacks, and merges them in */
  hydrator: Pick<ManifestHydrator, 'fetchAndHydrateRemoteItems'>
  storeItems: (items: VaultDoc[], options?: StoreItemsOptions) => Promise<void>
  /** Called with a server snapshot the local doc already holds, which wasn't fetched */
  onSnapshotCovered?: (itemId: ItemId, heads: string[]) => void
  /** Called once a sync has merged what it could, with the manifest it fetched */
  onManifestProcessed?: (manifest: ManifestEntry[]) => Promise<void>
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

/** A caller waiting on a manifest sync. A phase at its mode or a stronger one sets `result`. */
export interface ManifestSyncTicket {
  readonly mode: ManifestMode
  result?: ManifestPhaseResult
}

/** Where in the poll a manifest phase runs: before the log is read, or after */
export type ManifestStage = 'beforeRead' | 'afterRead'

const MODE_STRENGTH: Record<ManifestMode, number> = { due: 0, now: 1, force: 2 }

function strongerMode(a: ManifestMode | undefined, b: ManifestMode | undefined): ManifestMode | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return MODE_STRENGTH[b] > MODE_STRENGTH[a] ? b : a
}

function describeDemands(demands: ManifestDemand[]): string {
  return demands.map(demand => demand.purpose).join(', ')
}

const NOT_SYNCED: ManifestPhaseResult = { added: [], success: false, fetchedManifest: false }

/**
 * Runs the manifest sync as a phase of the poll, which carries the poll's abort signal, so a sync
 * stops with the poll that runs it.
 */
export class ManifestSyncManager {
  private readonly isAlive = () => !this.deps.session.isShutdown

  /** A sync asked for by an event (starting, coming online, foreground), kept until a phase serves it */
  private requested: ManifestMode | undefined
  private readonly tickets = new Set<ManifestSyncTicket>()
  /** The persisted time of the last clean sync, once read */
  private lastCleanAt: number | undefined
  /** When a sync last fetched the manifest, clean or not, so one with item failures retries hourly */
  private lastAttemptAt = 0

  constructor(private readonly deps: ManifestSyncManagerDeps) {}

  /** Asks the next poll's manifest phase for a sync at `mode` or stronger, kept until one fetches the manifest */
  request(mode: ManifestMode): void {
    this.requested = strongerMode(this.requested, mode)
  }

  /**
   * Registers a caller that waits for the next sync at `mode` or stronger. Unlike `request`, a ticket
   * lapses at `closeTicket`, so a sync that never ran isn't left asked for.
   */
  openTicket(mode: ManifestMode): ManifestSyncTicket {
    const ticket: ManifestSyncTicket = { mode }
    this.tickets.add(ticket)
    return ticket
  }

  /** Withdraws a ticket, returning the result of the sync that served it, or a failure if none did */
  closeTicket(ticket: ManifestSyncTicket): ManifestPhaseResult {
    this.tickets.delete(ticket)
    return ticket.result ?? NOT_SYNCED
  }

  /**
   * When the poll's manifest phase next has work, for scheduling polls: now while a sync is asked for,
   * otherwise `manifestSyncMinGap` after the last clean sync or `manifestSyncInterval` after the last
   * one that fetched the manifest, whichever is later. Undefined once the session is shutting down,
   * and before the last clean sync's time has been read.
   */
  getDueAt(now = Date.now()): number | undefined {
    if (!this.canSync) return undefined
    if (this.requested !== undefined || this.tickets.size > 0 || this.deps.demands.size > 0) return now
    return this.periodicDueAt
  }

  private get periodicDueAt(): number | undefined {
    if (this.lastCleanAt === undefined) return undefined
    return Math.max(this.lastCleanAt + MANIFEST_SYNC_MIN_GAP_MS, this.lastAttemptAt + MANIFEST_SYNC_INTERVAL_MS)
  }

  /**
   * One of the poll's manifest phases. Before the log is read, it runs a sync only for a demand that
   * must run then. After, it runs one for any demand, `request` or open ticket, or a `due` one if the
   * periodic sync is due. A sync that runs takes the strongest mode asked for and serves everything
   * it meets, and null means none ran. A manifest that can't be fetched throws, which fails the poll
   * (rule 4), and what was asked for stays asked for. Items that fail to hydrate don't throw: they
   * are left for the next sync.
   */
  async runPhase(stage: ManifestStage, signal: AbortSignal): Promise<ManifestPhaseResult | null> {
    const demands = this.deps.demands.list()
    const demanded = stage === 'afterRead' ? demands.length > 0 : demands.some(demand => demand.beforeRead)
    if (!this.canSync) {
      if (demanded) throw new Error(`${describeDemands(demands)} needs the manifest, which this session can't fetch now`)
      return null
    }
    this.lastCleanAt ??= await this.deps.indexManager.getLastManifestSyncTime()
    checkAlive(signal, this.isAlive)

    let mode: ManifestMode | undefined = demanded ? 'now' : undefined
    if (stage === 'afterRead' || demanded) {
      mode = strongerMode(mode, this.requested)
      for (const ticket of this.tickets) {
        mode = strongerMode(mode, ticket.mode)
      }
    }
    const periodicDueAt = this.periodicDueAt
    if (stage === 'afterRead' && mode === undefined && periodicDueAt !== undefined && Date.now() >= periodicDueAt) {
      mode = 'due'
    }
    if (mode === undefined) return null
    const strength = MODE_STRENGTH[mode]

    const served = Array.from(this.tickets).filter(ticket => MODE_STRENGTH[ticket.mode] <= strength)
    const requested = this.requested
    this.requested = undefined
    let result: ManifestPhaseResult
    try {
      result = await this.executeSync(mode, signal)
    } catch (error) {
      this.requested = strongerMode(this.requested, requested)
      throw error
    }
    for (const ticket of served) {
      ticket.result = result
      this.tickets.delete(ticket)
    }
    if (result.fetchedManifest) {
      for (const demand of demands) {
        this.deps.demands.meet(demand)
      }
    }
    return result
  }

  private get canSync(): boolean {
    return this.isAlive()
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
      snapshotSchedule.requestNow()
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

    await this.notifyManifestProcessed(manifest)
    checkAlive(signal, this.isAlive)

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

    for (const id of deltas.upstreamIds) {
      this.deps.snapshotSchedule.markItemDirty(id, UPSTREAM_SNAPSHOT_DEBOUNCE_MS)
    }
  }

  private async notifyManifestProcessed(manifest: ManifestEntry[]): Promise<void> {
    try {
      await this.deps.onManifestProcessed?.(manifest)
    } catch (error) {
      if (isAbortError(error)) throw error
      log.warn('Failed to process the manifest (will retry on next sync):', error)
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
