import type { VaultDoc } from '../shared/types'
import type { AutomergeDocStore, AutomergeIndexManager } from './docStore'
import type { SnapshotManager } from './SnapshotManager'
import type { ItemId } from 'src/shared/vault/ids'
import { SyncApiClient } from './SyncApiClient'
import type { VaultItem } from '../../api/vault/clientTypes'
import type { StoreItemsOptions } from './ItemOperations'
import { RecoveryManager } from './RecoveryManager'
import { SingleFlightGuard } from '../utils/SingleFlightGuard'
import { checkAlive, isAbortError } from '../utils/abort'
import { isAuthError } from './utils/errorClassifier'
import type { ManifestEntry } from 'src/shared/vault/api'
import {
  ManifestDeltaCalculator,
  type SyncDeltas,
  type CalculateSyncDeltasParams,
} from './ManifestDeltaCalculator'
import {
  ManifestHydrator,
  type HydrateItemResult,
  type FetchAndHydrateParams,
} from './ManifestHydrator'
import type { LifecycleAware } from './ServiceLifecycleManager'

const ONE_DAY_MS = 24 * 60 * 60 * 1000
const MANIFEST_SYNC_OFFLINE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000
const UPSTREAM_SNAPSHOT_DEBOUNCE_MS = 2000

export interface ManifestSyncManagerDeps {
  accountId: string
  docStore: AutomergeDocStore
  indexManager: AutomergeIndexManager
  snapshotManager: SnapshotManager
  recoveryManager?: RecoveryManager
  apiClient?: SyncApiClient
  onKeyVersionMissing?: (kver: string) => void
  storeItems: (items: VaultDoc[], options?: StoreItemsOptions) => Promise<void>
  onDecryptionFailure?: (itemId: ItemId, error: unknown) => void
  onItemSnapshotHydrated?: (itemId: ItemId, heads: string[]) => void
  /** Moves settings that predate the settings document into it (see AccountSettings) */
  migrateLegacySettings?: () => Promise<void>
  /**
   * Called, without waiting for it, after a sync in which every item hydrated, or one skipped because
   * such a sync ran recently
   */
  onSyncedWithoutFailures?: () => void
}

export type ManifestSyncManagerLegacyDeps = Omit<
  ManifestSyncManagerDeps,
  'storeItems' | 'onDecryptionFailure' | 'onItemSnapshotHydrated'
>

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

  constructor(
    deps: ManifestSyncManagerDeps | ManifestSyncManagerLegacyDeps,
    storeItems?: (items: VaultDoc[], options?: StoreItemsOptions) => Promise<void>,
    onDecryptionFailure?: (itemId: ItemId, error: unknown) => void,
    onItemSnapshotHydrated?: (itemId: ItemId, heads: string[]) => void,
  ) {
    if (typeof storeItems === 'function') {
      this.deps = {
        ...deps,
        storeItems,
        onDecryptionFailure,
        onItemSnapshotHydrated,
      } as ManifestSyncManagerDeps
    } else {
      this.deps = deps as ManifestSyncManagerDeps
    }

    this.apiClient = this.deps.apiClient ?? new SyncApiClient()
    this.recoveryManager = this.deps.recoveryManager ?? new RecoveryManager({ accountId: this.deps.accountId })
    this.hydrator = new ManifestHydrator({
      accountId: this.deps.accountId,
      apiClient: this.apiClient,
      docStore: this.deps.docStore,
      indexManager: this.deps.indexManager,
      snapshotManager: this.deps.snapshotManager,
      storeItems: this.deps.storeItems,
      onDecryptionFailure: this.deps.onDecryptionFailure,
      onItemSnapshotHydrated: this.deps.onItemSnapshotHydrated,
      onKeyVersionMissing: this.deps.onKeyVersionMissing,
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
    const isOfflineTooLong = timeSinceLastSync >= MANIFEST_SYNC_OFFLINE_THRESHOLD_MS
    const isWithinDailyWindow = hasKnownItems && timeSinceLastSync < ONE_DAY_MS
    return !force && !isOfflineTooLong && isWithinDailyWindow
  }

  private async fetchRemoteManifest(
    signal: AbortSignal,
    isAlive: () => boolean,
    hasKnownItems: boolean,
    outerSignal?: AbortSignal,
  ): Promise<{ manifest: ManifestEntry[]; serverTime: number } | null> {
    checkAlive(signal, isAlive)

    try {
      const manifestResponse = await this.apiClient.fetchManifest(
        { account: this.deps.accountId },
        outerSignal ? { signal } : undefined,
      )
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
          console.info('[ManifestSyncManager] No auth token, using local data only')
        } else {
          console.warn('[ManifestSyncManager] No API auth token found and no local data, cannot sync manifest from server')
        }
        return null
      }
      if (hasKnownItems) {
        console.warn('[ManifestSyncManager] Failed to fetch manifest, falling back to local data', e)
        return null
      }
      console.error('[ManifestSyncManager] Failed to fetch manifest', e)
      throw new Error(`[ManifestSyncManager] Failed to fetch manifest: ${(e as Error).message || String(e)}`, { cause: e })
    }
  }

  private async collectLocalSyncState(signal: AbortSignal, isAlive: () => boolean) {
    const tombstoneItemIds = (await this.deps.indexManager.listAutomergeTombstoneIds?.()) ?? []
    const localLastModifiedMap = new Map(this.deps.snapshotManager.exportLastModified())
    const localVersionsMap = new Map(this.deps.snapshotManager.exportItemVersions())
    checkAlive(signal, isAlive)

    const quarantinedMap = new Map<ItemId, number>()
    if (this.deps.accountId) {
      try {
        const recoveryEntries = await this.recoveryManager.listRecoveryItems(this.deps.accountId)
        checkAlive(signal, isAlive)
        for (const entry of recoveryEntries) {
          quarantinedMap.set(entry.itemId, entry.createdAt)
        }
      } catch (err) {
        if (signal.aborted || isAbortError(err)) throw err
        console.warn('[ManifestSyncManager] Failed to read manual recovery entries', err)
      }
    }

    return { tombstoneItemIds, localLastModifiedMap, quarantinedMap, localVersionsMap }
  }

  private createSyncAbortContext(outerSignal?: AbortSignal) {
    const abortController = new AbortController()
    const isAlive = () => !this.isShutdown && (!outerSignal || !outerSignal.aborted)

    if (outerSignal?.aborted) {
      abortController.abort(outerSignal.reason)
    } else if (outerSignal) {
      outerSignal.addEventListener('abort', () => abortController.abort(outerSignal.reason), { once: true })
    }

    return { abortController, signal: abortController.signal, isAlive }
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
      console.warn('[ManifestSyncManager] Failed to flush pending snapshots before sync', flushErr)
    }
  }

  private async recordSyncCompletion(hasFailures: boolean): Promise<void> {
    if (!hasFailures) {
      await this.deps.indexManager.updateLastManifestSyncTime(Date.now())
    } else {
      console.warn(
        '[ManifestSyncManager] Some batches or items failed to sync; lastManifestSyncTime not updated to allow retry',
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
      console.warn('[ManifestSyncManager] Failed to fetch manifest, falling back to local data', e)
      return { added: [], success: false }
    }
    console.error('[ManifestSyncManager] Failed to fetch manifest', e)
    throw new Error(`[ManifestSyncManager] Failed to fetch manifest: ${(e as Error).message || String(e)}`, { cause: e })
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

      const remoteData = await this.fetchRemoteManifest(signal, isAlive, hasKnownItems, outerSignal)
      if (!remoteData) {
        return { added: [], success: false }
      }
      checkAlive(signal, isAlive)

      await this.flushPendingSnapshotsSafely()
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
          outerSignal ? signal : undefined,
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

  calculateSyncDeltas(params: CalculateSyncDeltasParams): SyncDeltas {
    return ManifestDeltaCalculator.calculateSyncDeltas(params)
  }

  async pushLocalUpdates(
    deltasOrUpstreamIds:
      | SyncDeltas
      | (Pick<SyncDeltas, 'upstreamIds'> &
          Partial<Pick<SyncDeltas, 'locallyTombstonedSnapshots' | 'deletedLastModifiedUpdates' | 'deletedVersionUpdates'>>)
      | ItemId[],
  ): Promise<void> {
    if (Array.isArray(deltasOrUpstreamIds)) {
      for (const id of deltasOrUpstreamIds) {
        this.deps.snapshotManager.markItemDirty(id, UPSTREAM_SNAPSHOT_DEBOUNCE_MS)
      }
      return
    }

    if (
      deltasOrUpstreamIds.locallyTombstonedSnapshots &&
      deltasOrUpstreamIds.locallyTombstonedSnapshots.length > 0
    ) {
      try {
        await this.deps.storeItems(deltasOrUpstreamIds.locallyTombstonedSnapshots, { markDirty: false })
      } finally {
        for (const item of deltasOrUpstreamIds.locallyTombstonedSnapshots) {
          this.deps.snapshotManager.deleteDirtyItem?.(item.id)
        }
      }
    }

    if (
      deltasOrUpstreamIds.deletedLastModifiedUpdates &&
      deltasOrUpstreamIds.deletedLastModifiedUpdates.length > 0
    ) {
      for (const [id] of deltasOrUpstreamIds.deletedLastModifiedUpdates) {
        this.deps.snapshotManager.deleteDirtyItem?.(id)
      }
      await this.deps.snapshotManager.importLastModified(deltasOrUpstreamIds.deletedLastModifiedUpdates)
    }

    if (
      deltasOrUpstreamIds.deletedVersionUpdates &&
      deltasOrUpstreamIds.deletedVersionUpdates.length > 0
    ) {
      await this.deps.snapshotManager.importVersions(deltasOrUpstreamIds.deletedVersionUpdates)
    }

    if (deltasOrUpstreamIds.upstreamIds && deltasOrUpstreamIds.upstreamIds.length > 0) {
      for (const id of deltasOrUpstreamIds.upstreamIds) {
        this.deps.snapshotManager.markItemDirty(id, UPSTREAM_SNAPSHOT_DEBOUNCE_MS)
      }
    }
  }

  async fetchAndHydrateRemoteItems(
    params: FetchAndHydrateParams,
    signal?: AbortSignal,
  ): Promise<{ added: ItemId[]; hasFailures: boolean }> {
    return this.hydrator.fetchAndHydrateRemoteItems(params, signal)
  }

  async hydrateRemoteItem(
    item: VaultItem,
    manifest: ManifestEntry[],
    knownSet: Set<ItemId>,
    tombstoneSet: Set<ItemId> = new Set(),
    serverTimeFallback: number = Date.now(),
  ): Promise<HydrateItemResult> {
    return this.hydrator.hydrateRemoteItem(item, manifest, knownSet, tombstoneSet, serverTimeFallback)
  }

  private async migrateLegacySettings() {
    if (!this.deps.migrateLegacySettings) return
    try {
      await this.deps.migrateLegacySettings()
    } catch (error) {
      console.warn('[ManifestSyncManager] Legacy settings migration skipped (will retry on next sync):', error)
    }
  }
}
