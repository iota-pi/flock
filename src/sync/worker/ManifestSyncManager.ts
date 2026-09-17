import { chunk } from 'lodash-es'
import * as Automerge from '@automerge/automerge/slim'

import type { Item } from '../../state/items'
import type { AccountMetadata } from '../../state/metadata'
import { AutomergeDocStore } from './docStore'
import { AutomergeIndexManager } from './docStore/AutomergeIndexManager'
import type { SnapshotManager } from './SnapshotManager'
import { fetchManifest } from '../../api/vault/ItemClient'
import { decryptObject, hasVaultKey, waitForKeyVersion, type CryptoResult } from '../../api/vault'
import { decryptWithKeyResolution } from './utils/decryptWithKeyResolution'
import type { ItemId } from 'src/shared/schemas/items'
import { SyncApiClient } from './SyncApiClient'
import type { VaultItem } from '../../api/vault/clientTypes'
import type { StoreItemsOptions } from './ItemOperations'
import { RecoveryManager } from './RecoveryManager'
import { reconcileAccountMetadata, extractSyncableMetadata } from './utils/metadataSync'
import { SingleFlightGuard } from '../utils/SingleFlightGuard'
import { checkAlive, isAbortError } from './utils/abort'

const ONE_DAY_MS = 24 * 60 * 60 * 1000
const MANIFEST_SYNC_OFFLINE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000
const BATCH_SIZE = 50
const SKEW_BUFFER_MS = 60 * 1000
const UPSTREAM_SNAPSHOT_DEBOUNCE_MS = 2000

export type ManifestEntry = [itemId: string, serverTime: number, isDeleted?: boolean]

export interface SyncDeltas {
  missingIds: ItemId[]
  upstreamIds: ItemId[]
  locallyTombstonedSnapshots: Item[]
  deletedLastModifiedUpdates: [ItemId, number][]
  knownSet: Set<ItemId>
  tombstoneSet: Set<ItemId>
}

export type HydrateItemResult =
  | {
      status: 'success'
      itemId: ItemId
      hydratedId?: ItemId
      snapshot?: Item
      lastModifiedUpdate?: [ItemId, number]
    }
  | {
      status: 'decryption_failure'
      itemId: ItemId
      error: Error
    }
  | {
      status: 'error'
      itemId: ItemId
      error: unknown
    }

export class ManifestSyncManager {
  private recoveryManager: RecoveryManager
  private readonly apiClient: SyncApiClient
  private isShutdown = false
  private abortController: AbortController | null = null

  constructor(
    private deps: {
      accountId: string
      docStore: AutomergeDocStore
      indexManager: AutomergeIndexManager
      snapshotManager: SnapshotManager
      recoveryManager?: RecoveryManager
      apiClient?: SyncApiClient
      onKeyVersionMissing?: (kver: string) => void
    },
    private storeItems: (items: Item[], options?: StoreItemsOptions) => Promise<void>,
    private mutateMetadata: (changes: Partial<AccountMetadata>, options?: { pushRemote?: boolean }) => Promise<void>,
    private onDecryptionFailure?: (itemId: ItemId, error: unknown) => void,
    private onItemSnapshotHydrated?: (itemId: ItemId, heads: string[]) => void,
  ) {
    this.apiClient = deps.apiClient ?? new SyncApiClient()
    this.recoveryManager = deps.recoveryManager ?? new RecoveryManager({ accountId: deps.accountId })
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

  private readonly syncGuard = new SingleFlightGuard<{ added: ItemId[] }>()

  async sync(force = false, signal?: AbortSignal): Promise<{ added: ItemId[] }> {
    if (this.isShutdown || !this.deps.accountId) return { added: [] }
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
  ): Promise<{ manifest: ManifestEntry[]; serverTime: number; clockSkew: number } | null> {
    const hasToken = await this.apiClient.hasAuthToken()
    checkAlive(signal, isAlive)
    if (!hasToken) {
      if (hasKnownItems) {
        console.info('[ManifestSyncManager] No auth token, using local data only')
      } else {
        console.warn('[ManifestSyncManager] No API auth token found and no local data, cannot sync manifest from server')
      }
      return null
    }

    try {
      const requestStartTime = Date.now()
      const manifestResponse = await this.apiClient.fetchManifest(
        { account: this.deps.accountId },
        outerSignal ? { signal } : undefined,
      )
      const requestEndTime = Date.now()
      const clientMidTime = Math.round((requestStartTime + requestEndTime) / 2)
      const clockSkew = clientMidTime - manifestResponse.serverTime
      return {
        manifest: manifestResponse.manifest,
        serverTime: manifestResponse.serverTime,
        clockSkew,
      }
    } catch (e) {
      if (signal.aborted || isAbortError(e) || !isAlive()) {
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

    return { tombstoneItemIds, localLastModifiedMap, quarantinedMap }
  }

  private async executeSync(force = false, outerSignal?: AbortSignal): Promise<{ added: ItemId[] }> {
    const abortController = new AbortController()
    this.abortController = abortController
    const isAlive = () => !this.isShutdown && (!outerSignal || !outerSignal.aborted)

    if (outerSignal?.aborted) {
      abortController.abort(outerSignal.reason)
    } else if (outerSignal) {
      outerSignal.addEventListener('abort', () => abortController.abort(outerSignal.reason), { once: true })
    }
    const { signal } = abortController

    let hasKnownItems = false

    try {
      checkAlive(signal, isAlive)
      const knownItemIds = await this.deps.indexManager.listAutomergeItemIds()
      const lastManifestSyncTime = await this.deps.indexManager.getLastManifestSyncTime()
      checkAlive(signal, isAlive)

      hasKnownItems = knownItemIds.length > 0
      const timeSinceLastSync = lastManifestSyncTime > 0 ? Date.now() - lastManifestSyncTime : Infinity

      if (this.shouldSkipSync(force, hasKnownItems, timeSinceLastSync)) {
        return { added: [] }
      }

      const remoteData = await this.fetchRemoteManifest(signal, isAlive, hasKnownItems, outerSignal)
      if (!remoteData) {
        return { added: [] }
      }

      checkAlive(signal, isAlive)
      try {
        await this.deps.snapshotManager.flushPendingSnapshots()
      } catch (flushErr) {
        if (signal.aborted || isAbortError(flushErr)) throw flushErr
        console.warn('[ManifestSyncManager] Failed to flush pending snapshots before sync', flushErr)
      }

      checkAlive(signal, isAlive)
      const { tombstoneItemIds, localLastModifiedMap, quarantinedMap } =
        await this.collectLocalSyncState(signal, isAlive)
      checkAlive(signal, isAlive)

      // Step 1: Calculate sync deltas
      const deltas = this.calculateSyncDeltas({
        manifest: remoteData.manifest,
        clockSkew: remoteData.clockSkew,
        force,
        knownItemIds,
        tombstoneItemIds,
        localLastModifiedMap,
        quarantinedMap,
      })

      // Step 2: Push local updates (apply discovered local tombstones, update tombstone timestamps, mark upstream items dirty)
      checkAlive(signal, isAlive)
      await this.pushLocalUpdates(deltas)
      checkAlive(signal, isAlive)

      let added: ItemId[] = []
      let hasFailures = false

      // Step 3: Fetch and hydrate remote items (if any missing items need to be pulled)
      if (deltas.missingIds.length > 0) {
        checkAlive(signal, isAlive)
        const hydrationResult = await this.fetchAndHydrateRemoteItems({
          missingIds: deltas.missingIds,
          manifest: remoteData.manifest,
          serverTime: remoteData.serverTime,
          knownSet: deltas.knownSet,
          tombstoneSet: deltas.tombstoneSet,
        }, outerSignal ? signal : undefined)
        added = hydrationResult.added
        hasFailures = hydrationResult.hasFailures
      }

      checkAlive(signal, isAlive)
      await this.syncMetadata()
      checkAlive(signal, isAlive)

      if (!hasFailures) {
        await this.deps.indexManager.updateLastManifestSyncTime(Date.now())
      } else {
        console.warn(
          '[ManifestSyncManager] Some batches or items failed to sync; lastManifestSyncTime not updated to allow retry'
        )
      }

      return { added }
    } catch (e) {
      if (signal.aborted || isAbortError(e) || !isAlive()) {
        return { added: [] }
      }
      if (hasKnownItems) {
        console.warn('[ManifestSyncManager] Failed to fetch manifest, falling back to local data', e)
        return { added: [] }
      }
      console.error('[ManifestSyncManager] Failed to fetch manifest', e)
      throw new Error(`[ManifestSyncManager] Failed to fetch manifest: ${(e as Error).message || String(e)}`, { cause: e })
    } finally {
      if (this.abortController === abortController) {
        this.abortController = null
      }
    }
  }

  private calculateDownstreamDeltas(params: {
    manifest: ManifestEntry[]
    activeSet: Set<ItemId>
    tombstoneSet: Set<ItemId>
    knownSet: Set<ItemId>
    quarantinedMap: Map<ItemId, number>
    localLastModifiedMap: Map<string, number>
    clockSkew: number
    force: boolean
  }) {
    const locallyTombstonedSnapshots: Item[] = []
    const deletedLastModifiedUpdates: [ItemId, number][] = []
    const missingIds: ItemId[] = []

    for (const [itemId, serverTime, isDeleted] of params.manifest) {
      const id = itemId as ItemId
      if (!id) continue

      // If not forced and item is currently quarantined in manual recovery:
      // skip unless the server has a newer snapshot timestamp than when it was quarantined
      if (!params.force && params.quarantinedMap.has(id)) {
        const quarantinedAt = params.quarantinedMap.get(id) ?? 0
        if (serverTime <= quarantinedAt) {
          continue
        }
      }

      const localTime = params.localLastModifiedMap.get(id) ?? 0

      if (isDeleted) {
        if (params.activeSet.has(id)) {
          // Item exists locally and is active, but the server manifest indicates it is deleted.
          // Apply tombstone locally and record timestamp to prevent resurrection.
          locallyTombstonedSnapshots.push({ id, deleted: true } as unknown as Item)
          deletedLastModifiedUpdates.push([id, serverTime])
        } else if (serverTime > localTime) {
          // Item is deleted on server and client does not have it active (e.g. fresh login or already deleted).
          // Track that this item exists and is deleted at serverTime without fetching snapshot.
          deletedLastModifiedUpdates.push([id, serverTime])
        }
        continue
      }

      // If the item is already tombstoned locally, the local tombstone is terminal and authoritative.
      // Do NOT fetch older or concurrent active snapshot from server, which would cause resurrection.
      if (params.tombstoneSet.has(id)) {
        continue
      }

      if (localTime === 0) {
        missingIds.push(id)
        continue
      }
      if (params.force && !params.knownSet.has(id)) {
        missingIds.push(id)
        continue
      }
      if (serverTime === localTime) continue
      if (serverTime > localTime) {
        missingIds.push(id)
        continue
      }

      // Clock skew + buffer compensation for cases where client clock was ahead
      const adjustedLocalTime = localTime - Math.max(0, params.clockSkew) - SKEW_BUFFER_MS
      if (serverTime > adjustedLocalTime) {
        missingIds.push(id)
        continue
      }
    }

    return { missingIds, locallyTombstonedSnapshots, deletedLastModifiedUpdates }
  }

  private calculateUpstreamDeltas(params: {
    allLocalIds: Set<ItemId>
    missingSet: Set<ItemId>
    locallyTombstonedSet: Set<ItemId>
    tombstoneSet: Set<ItemId>
    serverManifestMap: Map<string, number>
    serverDeletedSet: Set<string>
    localLastModifiedMap: Map<string, number>
    clockSkew: number
  }): ItemId[] {
    const upstreamIds: ItemId[] = []
    for (const localId of params.allLocalIds) {
      if (params.missingSet.has(localId) || params.locallyTombstonedSet.has(localId)) continue
      const serverTime = params.serverManifestMap.get(localId)
      const localTime = params.localLastModifiedMap.get(localId) ?? 0

      if (serverTime === undefined) {
        // Item exists locally but is completely missing from server manifest
        upstreamIds.push(localId)
      } else if (params.tombstoneSet.has(localId) && !params.serverDeletedSet.has(localId)) {
        // Item is tombstoned locally, but server still has an active snapshot: push tombstone upstream
        upstreamIds.push(localId)
      } else {
        // Clock skew + buffer compensation: if local time exceeds server time
        const adjustedLocalTime = localTime - Math.max(0, params.clockSkew) - SKEW_BUFFER_MS
        if (adjustedLocalTime > serverTime) {
          upstreamIds.push(localId)
        }
      }
    }
    return upstreamIds
  }

  calculateSyncDeltas(params: {
    manifest: ManifestEntry[]
    clockSkew: number
    force: boolean
    knownItemIds: ItemId[]
    tombstoneItemIds: ItemId[]
    localLastModifiedMap: Map<string, number>
    quarantinedMap: Map<ItemId, number>
  }): SyncDeltas {
    const activeSet = new Set(params.knownItemIds)
    const serverManifestMap = new Map<string, number>(
      params.manifest.map(([itemId, serverTime]) => [itemId, serverTime]),
    )
    const serverDeletedSet = new Set<string>(
      params.manifest
        .filter(([, , isDeleted]) => isDeleted === true)
        .map(([itemId]) => itemId),
    )

    const tombstoneSet = new Set(params.tombstoneItemIds)
    for (const [id] of params.localLastModifiedMap) {
      if (!activeSet.has(id as ItemId)) {
        tombstoneSet.add(id as ItemId)
      }
    }
    const knownSet = new Set([...activeSet, ...tombstoneSet])

    const { missingIds, locallyTombstonedSnapshots, deletedLastModifiedUpdates } =
      this.calculateDownstreamDeltas({
        manifest: params.manifest,
        activeSet,
        tombstoneSet,
        knownSet,
        quarantinedMap: params.quarantinedMap,
        localLastModifiedMap: params.localLastModifiedMap,
        clockSkew: params.clockSkew,
        force: params.force,
      })

    // Two-Way Manifest Reconciliation (Upstream):
    // Identify local items that need to be pushed as snapshots to the server.
    // Exclude items that were just locally tombstoned.
    const upstreamIds = this.calculateUpstreamDeltas({
      allLocalIds: new Set([...params.knownItemIds, ...tombstoneSet]),
      missingSet: new Set(missingIds),
      locallyTombstonedSet: new Set(locallyTombstonedSnapshots.map(s => s.id as ItemId)),
      tombstoneSet,
      serverManifestMap,
      serverDeletedSet,
      localLastModifiedMap: params.localLastModifiedMap,
      clockSkew: params.clockSkew,
    })

    return {
      missingIds,
      upstreamIds,
      locallyTombstonedSnapshots,
      deletedLastModifiedUpdates,
      knownSet,
      tombstoneSet,
    }
  }

  async pushLocalUpdates(
    deltasOrUpstreamIds:
      | SyncDeltas
      | (Pick<SyncDeltas, 'upstreamIds'> &
          Partial<Pick<SyncDeltas, 'locallyTombstonedSnapshots' | 'deletedLastModifiedUpdates'>>)
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
      await this.storeItems(deltasOrUpstreamIds.locallyTombstonedSnapshots, { markDirty: false })
    }

    if (
      deltasOrUpstreamIds.deletedLastModifiedUpdates &&
      deltasOrUpstreamIds.deletedLastModifiedUpdates.length > 0
    ) {
      await this.deps.snapshotManager.importLastModified(deltasOrUpstreamIds.deletedLastModifiedUpdates)
    }

    if (deltasOrUpstreamIds.upstreamIds && deltasOrUpstreamIds.upstreamIds.length > 0) {
      for (const id of deltasOrUpstreamIds.upstreamIds) {
        this.deps.snapshotManager.markItemDirty(id, UPSTREAM_SNAPSHOT_DEBOUNCE_MS)
      }
    }
  }

  async fetchAndHydrateRemoteItems(
    params: {
      missingIds: ItemId[]
      manifest: ManifestEntry[]
      serverTime: number
      knownSet: Set<ItemId>
      tombstoneSet: Set<ItemId>
    },
    signal?: AbortSignal,
  ): Promise<{ added: ItemId[]; hasFailures: boolean }> {
    const batches = chunk(params.missingIds, BATCH_SIZE)
    const fetchedItems: VaultItem[] = []
    let hasBatchFailures = false

    for (const batch of batches) {
      checkAlive(signal, () => !this.isShutdown)
      try {
        const response = await this.apiClient.fetchSnapshotsByIds(
          {
            account: this.deps.accountId,
            itemIds: batch,
          },
          signal ? { signal } : undefined,
        )
        if (response?.items && Array.isArray(response.items)) {
          fetchedItems.push(...response.items)
        } else {
          hasBatchFailures = true
        }
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) {
          throw error
        }
        hasBatchFailures = true
        console.error('[ManifestSyncManager] Failed to fetch snapshot batch', {
          batch,
          error,
        })
      }
    }

    checkAlive(signal, () => !this.isShutdown)

    const validFetchedItems = fetchedItems.filter(
      entry =>
        entry &&
        typeof entry === 'object' &&
        typeof entry.item === 'string' &&
        entry.item.length > 0,
    )

    const snapshots: Item[] = []
    const hydratedIds: ItemId[] = []
    const lastModifiedUpdates: [ItemId, number][] = []
    let hasHydrationFailures = false

    const results = await Promise.allSettled(
      validFetchedItems.map(item =>
        this.hydrateRemoteItem(
          item,
          params.manifest,
          params.knownSet,
          params.tombstoneSet,
          params.serverTime,
        ),
      ),
    )

    for (const settled of results) {
      if (settled.status === 'rejected') {
        hasHydrationFailures = true
        console.error('[ManifestSyncManager] Unexpected error hydrating item', settled.reason)
        continue
      }

      const result = settled.value
      switch (result.status) {
        case 'success':
          if (result.hydratedId) {
            hydratedIds.push(result.hydratedId)
          }
          if (result.snapshot) {
            snapshots.push(result.snapshot)
          }
          if (result.lastModifiedUpdate) {
            lastModifiedUpdates.push(result.lastModifiedUpdate)
          }
          break
        case 'decryption_failure':
          hasHydrationFailures = true
          console.warn(
            `[ManifestSyncManager] Item ${result.itemId} could not be decrypted; quarantining to manual recovery`,
          )
          this.onDecryptionFailure?.(result.itemId, result.error)
          break
        case 'error':
          hasHydrationFailures = true
          console.error('[ManifestSyncManager] Failed to hydrate fetched item envelope', {
            itemId: result.itemId,
            error: result.error,
          })
          break
      }
    }

    if (hydratedIds.length > 0) {
      await this.deps.indexManager.addAutomergeItemIdsToIndex(hydratedIds)
    }

    if (snapshots.length > 0) {
      await this.storeItems(snapshots, { markDirty: false })
    }

    if (lastModifiedUpdates.length > 0) {
      await this.deps.snapshotManager.importLastModified(lastModifiedUpdates)
    }

    return {
      added: hydratedIds,
      hasFailures: hasBatchFailures || hasHydrationFailures,
    }
  }

  async hydrateRemoteItem(
    item: VaultItem,
    manifest: ManifestEntry[],
    knownSet: Set<ItemId>,
    tombstoneSet: Set<ItemId> = new Set(),
    serverTimeFallback: number = Date.now(),
  ): Promise<HydrateItemResult> {
    const itemId = item.item as ItemId
    try {
      const manifestEntry = manifest.find(([id]) => id === item.item)
      const serverTime = manifestEntry ? manifestEntry[1] : serverTimeFallback

      if (item.metadata?.deleted === true) {
        return {
          status: 'success',
          itemId,
          snapshot: { id: item.item, deleted: true } as unknown as Item,
          lastModifiedUpdate: [itemId, serverTime],
        }
      }

      if (item.snapshot) {
        const binary = await this.decryptSnapshotBinary(item.snapshot)
        if (binary) {
          const hydrationResult = await this.deps.docStore.hydrateAutomergeDocumentBinary(item.item, binary, {
            knownToExist: knownSet.has(itemId),
          })
          try {
            const heads = hydrationResult?.incomingHeads ?? Automerge.getHeads(Automerge.load(binary))
            this.onItemSnapshotHydrated?.(itemId, heads)
          } catch {}

          const isDeleted = Boolean(hydrationResult?.isDeleted || tombstoneSet.has(itemId))
          if (isDeleted) {
            await this.deps.indexManager.removeAutomergeItemIdsFromIndex([itemId])
          }

          if (hydrationResult?.hasLocalChanges) {
            this.deps.snapshotManager.markItemDirty(itemId, UPSTREAM_SNAPSHOT_DEBOUNCE_MS)
          }

          return {
            status: 'success',
            itemId,
            hydratedId: isDeleted ? undefined : itemId,
            lastModifiedUpdate: hydrationResult?.hasLocalChanges ? undefined : [itemId, serverTime],
          }
        }
      }

      const decryptedLegacy = await this.decryptLegacyCipher(item)
      if (decryptedLegacy && typeof decryptedLegacy === 'object' && !Array.isArray(decryptedLegacy)) {
        const snapshot = { ...(decryptedLegacy as Record<string, unknown>) }
        if (!snapshot.id || typeof snapshot.id !== 'string') {
          snapshot.id = item.item
        }
        const snapshotId = snapshot.id as ItemId
        if (tombstoneSet.has(snapshotId) && snapshot.deleted !== true) {
          await this.deps.indexManager.removeAutomergeItemIdsFromIndex([snapshotId])
          this.deps.snapshotManager.markItemDirty(snapshotId, UPSTREAM_SNAPSHOT_DEBOUNCE_MS)
          return {
            status: 'success',
            itemId,
          }
        }
        return {
          status: 'success',
          itemId,
          snapshot: snapshot as Item,
          lastModifiedUpdate: [snapshotId, serverTime],
        }
      }

      return {
        status: 'decryption_failure',
        itemId,
        error: new Error('Failed to decrypt snapshot binary or legacy cipher'),
      }
    } catch (error) {
      return {
        status: 'error',
        itemId,
        error,
      }
    }
  }

  private async decryptLegacyCipher(item: VaultItem): Promise<unknown> {
    if (
      typeof item.cipher !== 'string' ||
      item.cipher.length === 0 ||
      typeof item.metadata?.iv !== 'string' ||
      item.metadata.iv.length === 0
    ) {
      return null
    }

    const kver = (item.metadata as Record<string, unknown> | undefined)?.kver as string | undefined
    if (kver && !hasVaultKey(kver)) {
      if (this.deps.onKeyVersionMissing) {
        this.deps.onKeyVersionMissing(kver)
      }
      await waitForKeyVersion(kver, 3000)
    }
    return decryptObject({
      iv: item.metadata.iv,
      cipher: item.cipher,
      kver,
    }).catch(() => null)
  }

  private async decryptSnapshotBinary(
    encryptedAutomergeDoc: CryptoResult,
  ): Promise<Uint8Array | null> {
    try {
      return await decryptWithKeyResolution(encryptedAutomergeDoc, {
        timeoutMs: 3000,
        onKeyVersionMissing: this.deps.onKeyVersionMissing,
      })
    } catch {
      return null
    }
  }

  private async syncMetadata() {
    if (!this.deps.accountId) return
    const hasToken = await this.apiClient.hasAuthToken()
    if (!hasToken) return

    let remoteMetadata: AccountMetadata | null = null
    try {
      remoteMetadata = await this.apiClient.getAccountMetadata({
        account: this.deps.accountId,
      })
    } catch (error) {
      console.warn('[ManifestSyncManager] Metadata sync skipped (failed to query remote metadata):', error)
      return
    }

    try {
      const localMetadata = await this.deps.indexManager.getAutomergeMetadata()
      const { merged, needsRemotePush, hasLocalChanges } = reconcileAccountMetadata(
        localMetadata,
        remoteMetadata || undefined,
      )

      if (hasLocalChanges) {
        await this.mutateMetadata(merged, { pushRemote: false })
      }

      if (needsRemotePush) {
        const syncablePayload = extractSyncableMetadata(merged)
        await this.apiClient.updateAccountMetadata({
          account: this.deps.accountId,
          metadata: syncablePayload,
        })
      }
    } catch (error) {
      console.error('[ManifestSyncManager] Metadata reconciliation skipped', error)
    }
  }
}
