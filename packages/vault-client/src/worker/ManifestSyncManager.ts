import type { VaultDoc } from '../shared/types'
import type { AutomergeDocStore, AutomergeIndexManager } from './docStore'
import type { SnapshotManager } from './SnapshotManager'
import type { ItemId, ManifestEntry } from '@vault/shared'
import type { SyncApiClient } from './SyncApiClient'
import type { StoreItemsOptions } from './ItemOperations'
import type { SyncDomain } from './domain'
import type { RecoveryManager } from './RecoveryManager'
import { SingleFlightGuard } from '../utils/SingleFlightGuard'
import { AbortableRun } from '../utils/AbortableRun'
import { checkAlive, isAbortError } from '../utils/abort'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'
import { isAuthError } from '../utils/errorClassifier'
import { errorMessage } from '../utils/errorMessage'
import { calculateSyncDeltas, type QuarantinedItem, type SyncDeltas } from './calculateSyncDeltas'
import { ManifestHydrator } from './ManifestHydrator'
import { findSnapshotsCoveredLocally } from './findSnapshotsCoveredLocally'
import { areHeadsEqual } from './utils/automerge'
import type { SnapshotCoverage } from './SnapshotCoverage'
import type { KeyProvider } from '../keys/Keyring'
import { createLogger } from '../utils/logger'

const log = createLogger('ManifestSyncManager')

const MANIFEST_SYNC_MIN_GAP_MS = SYNC_TIMEOUTS.manifestSyncMinGap
const UPSTREAM_SNAPSHOT_DEBOUNCE_MS = SYNC_TIMEOUTS.upstreamSnapshotDebounce
const PULLED_CHANGES_GRACE_MS = SYNC_TIMEOUTS.pulledChangesGrace

export interface ManifestSyncManagerDeps {
  accountId: string
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
  coverage: Pick<SnapshotCoverage, 'listUnconfirmedPulls' | 'confirmPulledChanges'>
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

export class ManifestSyncManager {
  private readonly hydrator: ManifestHydrator
  private isShutdown = false

  private readonly isAlive = () => !this.isShutdown
  private readonly syncRun = new AbortableRun(this.isAlive)
  private readonly syncGuard = new SingleFlightGuard<SyncResult>()
  /** Whether the last sync run reached the end with a fetched manifest */
  private fetchedManifest = false

  constructor(private readonly deps: ManifestSyncManagerDeps) {
    this.hydrator = new ManifestHydrator({
      accountId: this.deps.accountId,
      apiClient: this.deps.apiClient,
      docStore: this.deps.docStore,
      indexManager: this.deps.indexManager,
      snapshotTracker: this.deps.snapshotManager.tracker,
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

  /** Resolves once the sync in flight, if any, has settled */
  async waitForIdle(): Promise<void> {
    await this.syncGuard.waitForRunning()
  }

  async sync(force = false, signal?: AbortSignal): Promise<SyncResult> {
    if (this.isShutdown) return { added: [], success: false }
    return this.syncGuard.run(() => this.executeSync(force, signal))
  }

  /**
   * Runs a sync now, whenever the last one was, and returns whether it fetched the manifest. A sync
   * that merged only some items counts: those items are left for the next one. It waits for a sync
   * in flight rather than sharing it, because that one may have skipped itself.
   */
  async syncNow(signal?: AbortSignal): Promise<boolean> {
    if (this.isShutdown) return false
    await this.syncGuard.waitForRunning()
    this.fetchedManifest = false
    await this.syncGuard.run(() => this.executeSync(false, signal, { ignoreMinGap: true }))
    return this.fetchedManifest
  }

  /** Fetches items' snapshots and merges them into their docs, away from any manifest sync */
  async fetchSnapshots(itemIds: ItemId[], signal?: AbortSignal): Promise<void> {
    if (this.isShutdown || itemIds.length === 0) return
    const [knownItemIds, tombstoneItemIds] = await Promise.all([
      this.deps.indexManager.listItemIds(),
      this.deps.indexManager.listTombstoneIds(),
    ])
    await this.hydrator.fetchAndHydrateRemoteItems({
      missingIds: itemIds,
      manifest: [],
      serverTime: Date.now(),
      knownSet: new Set(knownItemIds),
      tombstoneSet: new Set(tombstoneItemIds),
    }, signal)
  }

  private shouldSkipSync(force: boolean, hasKnownItems: boolean, timeSinceLastSync: number): boolean {
    if (this.deps.fetchManifestEverySync) return false
    return !force && hasKnownItems && timeSinceLastSync < MANIFEST_SYNC_MIN_GAP_MS
  }

  private async fetchRemoteManifest(
    signal: AbortSignal,
    hasKnownItems: boolean,
  ): Promise<{ manifest: ManifestEntry[]; serverTime: number } | null> {
    checkAlive(signal, this.isAlive)

    try {
      const manifestResponse = await this.deps.apiClient.fetchManifest({ account: this.deps.accountId }, { signal })
      return {
        manifest: manifestResponse.manifest,
        serverTime: manifestResponse.serverTime,
      }
    } catch (e) {
      if (signal.aborted || isAbortError(e) || !this.isAlive()) {
        return null
      }
      if (isAuthError(e)) {
        if (hasKnownItems) {
          log.info('No auth token, using local data only')
        } else {
          log.warn('No API auth token found and no local data, cannot sync manifest from server')
        }
        return null
      }
      if (hasKnownItems) {
        log.warn('Failed to fetch manifest, falling back to local data', e)
        return null
      }
      // Logged by handleSyncError
      throw new Error(`[ManifestSyncManager] Failed to fetch manifest: ${errorMessage(e)}`, { cause: e })
    }
  }

  private async collectLocalSyncState(signal: AbortSignal) {
    const tombstoneItemIds = await this.deps.indexManager.listTombstoneIds()
    const localLastModifiedMap = new Map(this.deps.snapshotManager.tracker.exportLastModified())
    const localVersionsMap = new Map(this.deps.snapshotManager.tracker.exportItemVersions())
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

    return { tombstoneItemIds, localLastModifiedMap, quarantinedMap, localVersionsMap }
  }

  private async checkGating(
    force: boolean,
    signal: AbortSignal,
  ): Promise<{ skip: boolean; hasKnownItems: boolean; knownItemIds: ItemId[] }> {
    checkAlive(signal, this.isAlive)
    const knownItemIds = await this.deps.indexManager.listItemIds()
    const lastManifestSyncTime = await this.deps.indexManager.getLastManifestSyncTime()
    checkAlive(signal, this.isAlive)

    const hasKnownItems = knownItemIds.length > 0
    const timeSinceLastSync = lastManifestSyncTime > 0 ? Date.now() - lastManifestSyncTime : Infinity
    const skip = this.shouldSkipSync(force, hasKnownItems, timeSinceLastSync)

    return { skip, hasKnownItems, knownItemIds }
  }

  private async flushPendingSnapshotsSafely(): Promise<void> {
    try {
      await this.deps.snapshotManager.flushPendingSnapshots()
    } catch (flushErr) {
      log.warn('Failed to flush pending snapshots before sync', flushErr)
    }
  }

  private async recordSyncCompletion(hasFailures: boolean): Promise<void> {
    if (!hasFailures) {
      await this.deps.indexManager.updateLastManifestSyncTime(Date.now())
    } else {
      log.warn(
        'Some batches or items failed to sync; lastManifestSyncTime not updated to allow retry',
      )
    }
  }

  private handleSyncError(e: unknown, hasKnownItems: boolean): SyncResult {
    if (isAbortError(e)) {
      return { added: [], success: false }
    }
    if (hasKnownItems) {
      log.warn('Manifest sync failed, falling back to local data', e)
      return { added: [], success: false }
    }
    log.error('Manifest sync failed', e)
    throw new Error(`[ManifestSyncManager] Manifest sync failed: ${errorMessage(e)}`, { cause: e })
  }

  private async executeSync(
    force = false,
    outerSignal?: AbortSignal,
    options: { ignoreMinGap?: boolean } = {},
  ): Promise<SyncResult> {
    let hasKnownItems = false
    try {
      return await this.syncRun.run(async signal => {
        const gating = await this.checkGating(force || options.ignoreMinGap === true, signal)
        hasKnownItems = gating.hasKnownItems
        if (gating.skip) {
          // Only a sync without failures records the time that lets later syncs be skipped
          this.deps.onSyncedWithoutFailures?.()
          return { added: [], success: true }
        }

        // Flushed first so the manifest includes them; otherwise they look missing and are pushed again
        await this.flushPendingSnapshotsSafely()
        checkAlive(signal, this.isAlive)

        const remoteData = await this.fetchRemoteManifest(signal, hasKnownItems)
        if (!remoteData) {
          return { added: [], success: false }
        }
        checkAlive(signal, this.isAlive)

        const localState = await this.collectLocalSyncState(signal)
        checkAlive(signal, this.isAlive)

        if (!force) {
          await this.skipSnapshotsCoveredLocally(remoteData.manifest, gating.knownItemIds, localState, signal)
          checkAlive(signal, this.isAlive)
        }

        // Step 1: Calculate sync deltas
        const deltas = calculateSyncDeltas({
          manifest: remoteData.manifest,
          force,
          knownItemIds: gating.knownItemIds,
          tombstoneItemIds: localState.tombstoneItemIds,
          localLastModifiedMap: localState.localLastModifiedMap,
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
              manifest: remoteData.manifest,
              serverTime: remoteData.serverTime,
              knownSet: deltas.knownSet,
              tombstoneSet: deltas.tombstoneSet,
            },
            signal,
          )
          added = hydrationResult.added
          hasFailures = hydrationResult.hasFailures
          checkAlive(signal, this.isAlive)
        }

        await this.notifyManifestProcessed(remoteData.manifest)
        checkAlive(signal, this.isAlive)
        this.fetchedManifest = true

        await this.migrateLegacySettings()
        checkAlive(signal, this.isAlive)

        await this.recordSyncCompletion(hasFailures)

        if (!hasFailures) {
          this.deps.onSyncedWithoutFailures?.()
        }

        return { added, success: !hasFailures }
      }, outerSignal)
    } catch (e) {
      return this.handleSyncError(e, hasKnownItems)
    }
  }

  private async pushLocalUpdates(deltas: SyncDeltas): Promise<void> {
    if (deltas.locallyTombstonedSnapshots.length > 0) {
      try {
        await this.deps.storeItems(deltas.locallyTombstonedSnapshots, { markDirty: false })
      } finally {
        for (const item of deltas.locallyTombstonedSnapshots) {
          this.deps.snapshotManager.tracker.deleteDirtyItem(item.id)
        }
      }
    }

    if (deltas.deletedLastModifiedUpdates.length > 0) {
      for (const [id] of deltas.deletedLastModifiedUpdates) {
        this.deps.snapshotManager.tracker.deleteDirtyItem(id)
      }
      await this.deps.snapshotManager.tracker.importLastModified(deltas.deletedLastModifiedUpdates)
    }

    if (deltas.deletedVersionUpdates.length > 0) {
      await this.deps.snapshotManager.tracker.importVersions(deltas.deletedVersionUpdates)
    }

    for (const id of deltas.upstreamIds) {
      this.deps.snapshotManager.tracker.markItemDirty(id, UPSTREAM_SNAPSHOT_DEBOUNCE_MS)
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
   * A device that holds changes must upload them if nobody else does (rule S3 of snapshot coverage).
   * So an item whose doc holds this snapshot and more gets a new one, once the author of any pulled
   * changes has had its chance.
   */
  private async skipSnapshotsCoveredLocally(
    manifest: ManifestEntry[],
    knownItemIds: ItemId[],
    localState: Awaited<ReturnType<ManifestSyncManager['collectLocalSyncState']>>,
    signal: AbortSignal,
  ): Promise<void> {
    const unconfirmedPulls = await this.deps.coverage.listUnconfirmedPulls()
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
    if (found.length === 0) return
    checkAlive(signal, this.isAlive)

    const covered = found.filter(snapshot => snapshot.isNewer)
    for (const { itemId, version } of covered) {
      const isDirty = localState.localVersionsMap.get(itemId)?.isDirty ?? false
      localState.localVersionsMap.set(itemId, { baseVersion: version, isDirty })
    }
    await this.deps.snapshotManager.tracker.importVersions(covered.map(({ itemId, version }) => [itemId, version]))
    for (const { itemId, heads } of covered) {
      this.deps.onSnapshotCovered?.(itemId, heads)
    }
    if (covered.length > 0) {
      log.info(`Skipped fetching ${covered.length} snapshots this device already has`)
    }

    const graceStart = Date.now() - PULLED_CHANGES_GRACE_MS
    const confirmed: ItemId[] = []
    for (const { itemId, heads, docHeads, isNewer } of found) {
      if (areHeadsEqual(heads, docHeads)) {
        if (unconfirmedPulls.has(itemId)) confirmed.push(itemId)
      } else if (isNewer || (unconfirmedPulls.get(itemId) ?? Infinity) <= graceStart) {
        this.deps.snapshotManager.tracker.markItemDirty(itemId, UPSTREAM_SNAPSHOT_DEBOUNCE_MS)
      }
    }
    await this.deps.coverage.confirmPulledChanges(confirmed)
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
