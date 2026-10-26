import type { VaultDoc } from '../shared/types'
import type { AutomergeDocStore, AutomergeIndexManager } from './docStore'
import type { SnapshotManager } from './SnapshotManager'
import type { ItemId, ManifestEntry } from '@vault/shared'
import type { SyncApiClient } from './SyncApiClient'
import type { StoreItemsOptions } from './ItemOperations'
import type { SyncDomain } from './domain'
import type { RecoveryManager } from './RecoveryManager'
import { SingleFlightGuard } from '../utils/SingleFlightGuard'
import { checkAlive, isAbortError } from '../utils/abort'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'
import { isAuthError } from '../utils/errorClassifier'
import { errorMessage } from '../utils/errorMessage'
import { ManifestDeltaCalculator, type SyncDeltas } from './ManifestDeltaCalculator'
import { ManifestHydrator } from './ManifestHydrator'
import type { LifecycleAware } from './ServiceLifecycleManager'
import type { KeyProvider } from '../../api/Keyring'
import { createLogger } from '../utils/logger'

const log = createLogger('ManifestSyncManager')

const ONE_DAY_MS = 24 * 60 * 60 * 1000
const MANIFEST_SYNC_OFFLINE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000
const UPSTREAM_SNAPSHOT_DEBOUNCE_MS = SYNC_TIMEOUTS.upstreamSnapshotDebounce

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
  onDecryptionFailure?: (itemId: ItemId, error: unknown) => void
  onItemSnapshotHydrated?: (itemId: ItemId, heads: string[]) => void
  decodeLegacyItem?: SyncDomain['decodeLegacyItem']
  /** Called when the server holds legacy rows and there is no `decodeLegacyItem` hook to read them */
  onMigrationRequired?: () => void
  /** Fetches the manifest on every sync, rather than at most daily on a device that has items */
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

export class ManifestSyncManager implements LifecycleAware {
  readonly lifecycleName = 'ManifestSyncManager'
  private readonly deps: ManifestSyncManagerDeps
  private readonly hydrator: ManifestHydrator
  private readonly recoveryManager: RecoveryManager
  private readonly apiClient: SyncApiClient
  private isShutdown = false

  onLifecycleStop(): void {
    this.shutdown()
  }

  private abortController: AbortController | null = null
  private readonly syncGuard = new SingleFlightGuard<SyncResult>()

  constructor(deps: ManifestSyncManagerDeps) {
    this.deps = deps
    this.apiClient = this.deps.apiClient
    this.recoveryManager = this.deps.recoveryManager
    this.hydrator = new ManifestHydrator({
      accountId: this.deps.accountId,
      apiClient: this.apiClient,
      docStore: this.deps.docStore,
      indexManager: this.deps.indexManager,
      snapshotManager: this.deps.snapshotManager,
      keys: this.deps.keys,
      storeItems: this.deps.storeItems,
      onDecryptionFailure: this.deps.onDecryptionFailure,
      onItemSnapshotHydrated: this.deps.onItemSnapshotHydrated,
      onKeyVersionMissing: this.deps.onKeyVersionMissing,
      decodeLegacyItem: this.deps.decodeLegacyItem,
      onMigrationRequired: this.deps.onMigrationRequired,
      isShutdown: () => this.isShutdown,
    })
  }

  abort(): void {
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }
  }

  shutdown(): void {
    this.isShutdown = true
    this.abort()
  }

  async sync(force = false, signal?: AbortSignal): Promise<SyncResult> {
    if (this.isShutdown || !this.deps.accountId) return { added: [], success: false }
    return this.syncGuard.run(() => this.executeSync(force, signal))
  }

  private shouldSkipSync(force: boolean, hasKnownItems: boolean, timeSinceLastSync: number): boolean {
    if (this.deps.fetchManifestEverySync) return false
    const isOfflineTooLong = timeSinceLastSync >= MANIFEST_SYNC_OFFLINE_THRESHOLD_MS
    const isWithinDailyWindow = hasKnownItems && timeSinceLastSync < ONE_DAY_MS
    return !force && !isOfflineTooLong && isWithinDailyWindow
  }

  private async fetchRemoteManifest(
    signal: AbortSignal,
    isAlive: () => boolean,
    hasKnownItems: boolean,
  ): Promise<{ manifest: ManifestEntry[]; serverTime: number } | null> {
    checkAlive(signal, isAlive)

    try {
      const manifestResponse = await this.apiClient.fetchManifest({ account: this.deps.accountId }, { signal })
      return {
        manifest: manifestResponse.manifest,
        serverTime: manifestResponse.serverTime,
      }
    } catch (e) {
      if (signal.aborted || isAbortError(e) || !isAlive()) {
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

  private async collectLocalSyncState(signal: AbortSignal, isAlive: () => boolean) {
    const tombstoneItemIds = await this.deps.indexManager.listAutomergeTombstoneIds()
    const localLastModifiedMap = new Map(this.deps.snapshotManager.exportLastModified())
    const localVersionsMap = new Map(this.deps.snapshotManager.exportItemVersions())
    checkAlive(signal, isAlive)

    const quarantinedMap = new Map<ItemId, number>()
    try {
      const recoveryEntries = await this.recoveryManager.listRecoveryItems()
      checkAlive(signal, isAlive)
      for (const entry of recoveryEntries) {
        quarantinedMap.set(entry.itemId, entry.createdAt)
      }
    } catch (err) {
      if (signal.aborted || isAbortError(err)) throw err
      log.warn('Failed to read manual recovery entries', err)
    }

    return { tombstoneItemIds, localLastModifiedMap, quarantinedMap, localVersionsMap }
  }

  private createSyncAbortContext(outerSignal?: AbortSignal) {
    const abortController = new AbortController()
    const signal = outerSignal ? AbortSignal.any([abortController.signal, outerSignal]) : abortController.signal
    const isAlive = () => !this.isShutdown && !outerSignal?.aborted
    return { abortController, signal, isAlive }
  }

  private async checkGating(
    force: boolean,
    signal: AbortSignal,
    isAlive: () => boolean,
  ): Promise<{ skip: boolean; hasKnownItems: boolean; knownItemIds: ItemId[] }> {
    checkAlive(signal, isAlive)
    const knownItemIds = await this.deps.indexManager.listAutomergeItemIds()
    const lastManifestSyncTime = await this.deps.indexManager.getLastManifestSyncTime()
    checkAlive(signal, isAlive)

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

  private handleSyncError(
    e: unknown,
    signal: AbortSignal,
    isAlive: () => boolean,
    hasKnownItems: boolean,
  ): SyncResult {
    if (signal.aborted || isAbortError(e) || !isAlive()) {
      return { added: [], success: false }
    }
    if (hasKnownItems) {
      log.warn('Manifest sync failed, falling back to local data', e)
      return { added: [], success: false }
    }
    log.error('Manifest sync failed', e)
    throw new Error(`[ManifestSyncManager] Manifest sync failed: ${errorMessage(e)}`, { cause: e })
  }

  private async executeSync(force = false, outerSignal?: AbortSignal): Promise<SyncResult> {
    const { abortController, signal, isAlive } = this.createSyncAbortContext(outerSignal)
    this.abortController = abortController

    let hasKnownItems = false
    try {
      const gating = await this.checkGating(force, signal, isAlive)
      hasKnownItems = gating.hasKnownItems
      if (gating.skip) {
        // Only a sync without failures records the time that lets later syncs be skipped
        this.deps.onSyncedWithoutFailures?.()
        return { added: [], success: true }
      }

      // Flushed first so the manifest includes them; otherwise they look missing and are pushed again
      await this.flushPendingSnapshotsSafely()
      checkAlive(signal, isAlive)

      const remoteData = await this.fetchRemoteManifest(signal, isAlive, hasKnownItems)
      if (!remoteData) {
        return { added: [], success: false }
      }
      checkAlive(signal, isAlive)

      const localState = await this.collectLocalSyncState(signal, isAlive)
      checkAlive(signal, isAlive)

      // Step 1: Calculate sync deltas
      const deltas = ManifestDeltaCalculator.calculateSyncDeltas({
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
      checkAlive(signal, isAlive)

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
        checkAlive(signal, isAlive)
      }

      await this.migrateLegacySettings()
      checkAlive(signal, isAlive)

      await this.recordSyncCompletion(hasFailures)

      if (!hasFailures) {
        this.deps.onSyncedWithoutFailures?.()
      }

      return { added, success: !hasFailures }
    } catch (e) {
      return this.handleSyncError(e, signal, isAlive, hasKnownItems)
    } finally {
      if (this.abortController === abortController) {
        this.abortController = null
      }
    }
  }

  async pushLocalUpdates(deltas: SyncDeltas): Promise<void> {
    if (deltas.locallyTombstonedSnapshots.length > 0) {
      try {
        await this.deps.storeItems(deltas.locallyTombstonedSnapshots, { markDirty: false })
      } finally {
        for (const item of deltas.locallyTombstonedSnapshots) {
          this.deps.snapshotManager.deleteDirtyItem(item.id)
        }
      }
    }

    if (deltas.deletedLastModifiedUpdates.length > 0) {
      for (const [id] of deltas.deletedLastModifiedUpdates) {
        this.deps.snapshotManager.deleteDirtyItem(id)
      }
      await this.deps.snapshotManager.importLastModified(deltas.deletedLastModifiedUpdates)
    }

    if (deltas.deletedVersionUpdates && deltas.deletedVersionUpdates.length > 0) {
      await this.deps.snapshotManager.importVersions(deltas.deletedVersionUpdates)
    }

    for (const id of deltas.upstreamIds) {
      this.deps.snapshotManager.markItemDirty(id, UPSTREAM_SNAPSHOT_DEBOUNCE_MS)
    }
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
