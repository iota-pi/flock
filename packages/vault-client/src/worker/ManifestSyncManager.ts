import type { VaultDoc } from '../shared/types'
import type { AutomergeDocStore, AutomergeIndexManager } from './docStore'
import type { SnapshotManager } from './SnapshotManager'
import type { ItemId, ManifestEntry } from '@vault/shared'
import type { SyncApiClient } from './SyncApiClient'
import type { StoreItemsOptions } from './ItemOperations'
import type { SyncDomain } from './domain'
import type { RecoveryManager } from './RecoveryManager'
import type { SyncSessionState } from './SyncSessionState'
import { AbortableRun } from '../utils/AbortableRun'
import { checkAlive, isAbortError } from '../utils/abort'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'
import { calculateSyncDeltas, type QuarantinedItem, type SyncDeltas } from './calculateSyncDeltas'
import { ManifestHydrator } from './ManifestHydrator'
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
  /** Only the leader talks to the server, so a sync in any other tab does nothing */
  session: Pick<SyncSessionState, 'isLeader'>
  docStore: AutomergeDocStore
  indexManager: AutomergeIndexManager
  snapshotManager: SnapshotManager
  keys: KeyProvider
  recoveryManager: RecoveryManager
  apiClient: SyncApiClient
  onKeyVersionMissing?: (kver: string) => void
  storeItems: (items: VaultDoc[], options?: StoreItemsOptions) => Promise<void>
  onDecryptionFailure?: (itemId: ItemId, error: unknown, serverVersion?: number) => void
  /** Called for an item that keeps failing to hydrate with an error (see ManifestHydratorDeps) */
  onRepeatedHydrationError?: (itemId: ItemId, error: unknown, serverVersion?: number) => void
  onItemSnapshotHydrated?: (itemId: ItemId, heads: string[]) => void
  /** Called with a server snapshot the local doc already holds, which wasn't fetched */
  onSnapshotCovered?: (itemId: ItemId, heads: string[]) => void
  /** Called with an item whose doc has changes a snapshot merged into it lacks */
  onLocalChangesFound?: (itemId: ItemId) => void
  /** Called once a sync has merged what it could, with the manifest it fetched */
  onManifestProcessed?: (manifest: ManifestEntry[]) => Promise<void>
  /** The items' unconfirmed pulls, for snapshot coverage's S2 */
  itemSyncState: Pick<ItemSyncState, 'listUnconfirmedPulls' | 'confirmPulledChanges'>
  decodeLegacyItem?: SyncDomain['decodeLegacyItem']
  /** Called when the server holds legacy rows and there is no `decodeLegacyItem` hook to read them */
  onMigrationRequired?: () => void
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

const MODE_STRENGTH: Record<ManifestMode, number> = { due: 0, now: 1, force: 2 }

function strongerMode(a: ManifestMode | undefined, b: ManifestMode | undefined): ManifestMode | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return MODE_STRENGTH[b] > MODE_STRENGTH[a] ? b : a
}

const NOT_SYNCED: ManifestPhaseResult = { added: [], success: false, fetchedManifest: false }

export class ManifestSyncManager {
  private readonly hydrator: ManifestHydrator
  private isShutdown = false

  private readonly isAlive = () => !this.isShutdown
  private readonly syncRun = new AbortableRun(this.isAlive)

  /** A sync asked for by an event (promotion, coming online, foreground), kept until a phase serves it */
  private requested: ManifestMode | undefined
  private readonly tickets = new Set<ManifestSyncTicket>()
  /** The persisted time of the last clean sync, once read */
  private lastCleanAt: number | undefined
  /** When a sync last fetched the manifest, clean or not, so one with item failures retries hourly */
  private lastAttemptAt = 0

  constructor(private readonly deps: ManifestSyncManagerDeps) {
    this.hydrator = new ManifestHydrator({
      accountId: this.deps.accountId,
      apiClient: this.deps.apiClient,
      docStore: this.deps.docStore,
      indexManager: this.deps.indexManager,
      itemSyncState: this.deps.snapshotManager.state,
      snapshotSchedule: this.deps.snapshotManager.schedule,
      keys: this.deps.keys,
      storeItems: this.deps.storeItems,
      onDecryptionFailure: this.deps.onDecryptionFailure,
      onRepeatedHydrationError: this.deps.onRepeatedHydrationError,
      onItemSnapshotHydrated: this.deps.onItemSnapshotHydrated,
      onLocalChangesFound: this.deps.onLocalChangesFound,
      onKeyVersionMissing: this.deps.onKeyVersionMissing,
      decodeLegacyItem: this.deps.decodeLegacyItem,
      onMigrationRequired: this.deps.onMigrationRequired,
      isShutdown: () => this.isShutdown,
    })
  }

  abort(): void {
    this.syncRun.abort()
  }

  shutdown(): void {
    this.isShutdown = true
    this.abort()
  }

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
   * one that fetched the manifest, whichever is later. Undefined outside the leader, and before the
   * last clean sync's time has been read.
   */
  getDueAt(now = Date.now()): number | undefined {
    if (!this.canSync) return undefined
    if (this.requested !== undefined || this.tickets.size > 0) return now
    return this.periodicDueAt
  }

  private get periodicDueAt(): number | undefined {
    if (this.lastCleanAt === undefined) return undefined
    return Math.max(this.lastCleanAt + MANIFEST_SYNC_MIN_GAP_MS, this.lastAttemptAt + MANIFEST_SYNC_INTERVAL_MS)
  }

  /**
   * The poll's manifest phase. Runs a sync at the strongest mode asked for (by `request`, an open
   * ticket or `minMode`), or a `due` one if the periodic sync is due, and returns null if none is.
   * A manifest that can't be fetched throws, which fails the poll (rule 4), and what was asked for stays
   * asked for. Items that fail to hydrate don't throw: they are left for the next sync.
   */
  async runPhase(signal?: AbortSignal, minMode?: ManifestMode): Promise<ManifestPhaseResult | null> {
    if (!this.canSync) return null
    this.lastCleanAt ??= await this.deps.indexManager.getLastManifestSyncTime()
    checkAlive(signal, this.isAlive)

    let mode = strongerMode(this.requested, minMode)
    for (const ticket of this.tickets) {
      mode = strongerMode(mode, ticket.mode)
    }
    const periodicDueAt = this.periodicDueAt
    if (mode === undefined && periodicDueAt !== undefined && Date.now() >= periodicDueAt) {
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
    return result
  }

  private get canSync(): boolean {
    return !this.isShutdown && this.deps.session.isLeader
  }

  /** Fetches items' snapshots and merges them into their docs, away from any manifest sync */
  async fetchSnapshots(itemIds: ItemId[], signal?: AbortSignal): Promise<void> {
    if (!this.canSync || itemIds.length === 0) return
    const [knownItemIds, tombstoneItemIds] = await Promise.all([
      this.deps.indexManager.listItemIds(),
      this.deps.indexManager.listTombstoneIds(),
    ])
    await this.hydrator.fetchAndHydrateRemoteItems({
      missingIds: itemIds,
      manifest: [],
      knownSet: new Set(knownItemIds),
      tombstoneSet: new Set(tombstoneItemIds),
    }, signal)
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
    const localVersionsMap = this.deps.snapshotManager.exportItemVersions()
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

  private async checkGating(
    mode: ManifestMode,
    signal: AbortSignal,
  ): Promise<{ skip: boolean; hasKnownItems: boolean; knownItemIds: ItemId[] }> {
    checkAlive(signal, this.isAlive)
    const knownItemIds = await this.deps.indexManager.listItemIds()
    // Read every time: another tab may have synced while this one wasn't leading
    const lastManifestSyncTime = await this.deps.indexManager.getLastManifestSyncTime()
    checkAlive(signal, this.isAlive)
    this.lastCleanAt = lastManifestSyncTime

    const hasKnownItems = knownItemIds.length > 0
    const timeSinceLastSync = lastManifestSyncTime > 0 ? Date.now() - lastManifestSyncTime : Infinity
    const skip = this.shouldSkipSync(mode, hasKnownItems, timeSinceLastSync)

    return { skip, hasKnownItems, knownItemIds }
  }

  /**
   * Uploads every dirty item's snapshot through the snapshot phase's upload. The manifest sync is
   * itself a phase of the poll, so nothing else is uploading.
   */
  private async flushPendingSnapshotsSafely(signal: AbortSignal): Promise<void> {
    const { snapshotManager } = this.deps
    if (snapshotManager.schedule.dirtyCount === 0) return
    try {
      snapshotManager.schedule.requestNow()
      await snapshotManager.pushDue(signal)
    } catch (flushErr) {
      if (signal.aborted || isAbortError(flushErr)) throw flushErr
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

  private async executeSync(mode: ManifestMode, outerSignal?: AbortSignal): Promise<ManifestPhaseResult> {
    const force = mode === 'force'
    return this.syncRun.run(async signal => {
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
        const hydrationResult = await this.hydrator.fetchAndHydrateRemoteItems(
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
    }, outerSignal)
  }

  private async pushLocalUpdates(deltas: SyncDeltas): Promise<void> {
    if (deltas.locallyTombstonedSnapshots.length > 0) {
      try {
        await this.deps.storeItems(deltas.locallyTombstonedSnapshots, { markDirty: false })
      } finally {
        for (const item of deltas.locallyTombstonedSnapshots) {
          this.deps.snapshotManager.schedule.deleteDirtyItem(item.id)
        }
      }
    }

    if (deltas.deletedVersionUpdates.length > 0) {
      for (const [id] of deltas.deletedVersionUpdates) {
        this.deps.snapshotManager.schedule.deleteDirtyItem(id)
      }
      // The tombstones must be stored before the base version says this device has them (rule 1)
      await this.deps.docStore.flushToStorage(deltas.locallyTombstonedSnapshots.map(item => item.id))
      await this.deps.snapshotManager.state.importBaseVersions(deltas.deletedVersionUpdates)
    }

    for (const id of deltas.upstreamIds) {
      this.deps.snapshotManager.schedule.markItemDirty(id, UPSTREAM_SNAPSHOT_DEBOUNCE_MS)
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
      await this.deps.snapshotManager.state.importBaseVersions(covered.map(({ itemId, version }) => [itemId, version]))
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
        this.deps.snapshotManager.schedule.markItemDirty(itemId, UPSTREAM_SNAPSHOT_DEBOUNCE_MS)
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
        this.deps.snapshotManager.schedule.markItemDirty(entry.itemId, UPSTREAM_SNAPSHOT_DEBOUNCE_MS)
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
