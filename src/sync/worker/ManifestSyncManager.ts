import { chunk } from 'lodash-es'
import * as Automerge from '@automerge/automerge/slim'

import type { Item } from '../../state/items'
import type { AccountMetadata } from '../../state/metadata'
import { AutomergeDocStore } from './docStore'
import { AutomergeIndexManager } from './docStore/AutomergeIndexManager'
import type { SnapshotManager } from './SnapshotManager'
import { fetchManifest, fetchSnapshotsByIds } from '../../api/vault/ItemClient'
import { decryptObject, decryptBytes, hasVaultKey, waitForKeyVersion, type CryptoResult } from '../../api/vault'
import { hasApiAuthToken } from '../../api/runtime'
import type { ItemId } from 'src/shared/schemas/items'
import { getTrpcClient } from 'src/api/trpcClient'
import type { VaultItem } from '../../api/vault/clientTypes'
import type { StoreItemsOptions } from './ItemOperations'
import { readManualRecoveryEntries } from '../shared/manualRecoveryStore'

const ONE_DAY_MS = 24 * 60 * 60 * 1000
const MANIFEST_SYNC_OFFLINE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000
const BATCH_SIZE = 50
const SKEW_BUFFER_MS = 60 * 1000
const UPSTREAM_SNAPSHOT_DEBOUNCE_MS = 2000

export class ManifestSyncManager {
  constructor(
    private deps: {
      accountId: string
      docStore: AutomergeDocStore
      indexManager: AutomergeIndexManager
      snapshotManager: SnapshotManager
    },
    private storeItems: (items: Item[], options?: StoreItemsOptions) => Promise<void>,
    private mutateMetadata: (changes: Partial<AccountMetadata>) => Promise<void>,
    private onDecryptionFailure?: (itemId: ItemId, error: unknown) => void,
    private onItemSnapshotHydrated?: (itemId: ItemId, heads: string[]) => void,
  ) {}

  private activeSyncPromise: Promise<{ added: ItemId[] }> | null = null

  async sync(force = false): Promise<{ added: ItemId[] }> {
    if (!this.deps.accountId) return { added: [] }

    if (this.activeSyncPromise) {
      return this.activeSyncPromise
    }

    const syncTask = this.executeSync(force)
    this.activeSyncPromise = syncTask
    try {
      return await syncTask
    } finally {
      if (this.activeSyncPromise === syncTask) {
        this.activeSyncPromise = null
      }
    }
  }

  private async executeSync(force = false): Promise<{ added: ItemId[] }> {
    const knownItemIds = await this.deps.indexManager.listAutomergeItemIds()
    const lastManifestSyncTime = await this.deps.indexManager.getLastManifestSyncTime()

    const hasKnownItems = knownItemIds.length > 0
    const timeSinceLastSync = lastManifestSyncTime > 0 ? Date.now() - lastManifestSyncTime : Infinity

    // Gating logic:
    // - Force runs unconditionally
    // - If it has been more than 7 days, always run (even if not forced)
    // - If we already have items and last run was less than 24 hours ago, skip
    const isOfflineTooLong = timeSinceLastSync >= MANIFEST_SYNC_OFFLINE_THRESHOLD_MS
    const isWithinDailyWindow = hasKnownItems && timeSinceLastSync < ONE_DAY_MS

    if (!force && !isOfflineTooLong && isWithinDailyWindow) {
      return { added: [] }
    }

    if (!hasApiAuthToken()) {
      if (hasKnownItems) {
        console.info('[ManifestSyncManager] No auth token, using local data only')
        return { added: [] }
      }
      console.warn('[ManifestSyncManager] No API auth token found and no local data, cannot sync manifest from server')
      return { added: [] }
    }

    let manifestResponse: Awaited<ReturnType<typeof fetchManifest>>
    let clockSkew = 0
    try {
      const requestStartTime = Date.now()
      manifestResponse = await fetchManifest({
        account: this.deps.accountId,
      })
      const requestEndTime = Date.now()
      const clientMidTime = Math.round((requestStartTime + requestEndTime) / 2)
      clockSkew = clientMidTime - manifestResponse.serverTime
    } catch (e) {
      if (hasKnownItems) {
        console.warn('[ManifestSyncManager] Failed to fetch manifest, falling back to local data', e)
        return { added: [] }
      }
      console.error('[ManifestSyncManager] Failed to fetch manifest', e)
      throw new Error(`[ManifestSyncManager] Failed to fetch manifest: ${(e as Error).message || String(e)}`, { cause: e })
    }

    try {
      await this.deps.snapshotManager.flushPendingSnapshots()
    } catch (flushErr) {
      console.warn('[ManifestSyncManager] Failed to flush pending snapshots before sync', flushErr)
    }

    const knownSet = new Set(knownItemIds)
    const localLastModifiedMap = new Map(this.deps.snapshotManager.exportLastModified())
    const serverManifestMap = new Map<string, number>(manifestResponse.manifest.map(([itemId, serverTime]) => [itemId, serverTime]))

    let quarantinedMap = new Map<ItemId, number>()
    if (this.deps.accountId) {
      try {
        const recoveryEntries = await readManualRecoveryEntries(this.deps.accountId)
        for (const entry of recoveryEntries) {
          quarantinedMap.set(entry.itemId, entry.createdAt)
        }
      } catch (err) {
        console.warn('[ManifestSyncManager] Failed to read manual recovery entries', err)
      }
    }

    const locallyTombstonedSnapshots: Item[] = []
    const deletedLastModifiedUpdates: [ItemId, number][] = []
    const missingIds: ItemId[] = []

    for (const [itemId, serverTime, isDeleted] of manifestResponse.manifest) {
      const id = itemId as ItemId
      if (!id) continue

      // If not forced and item is currently quarantined in manual recovery:
      // skip unless the server has a newer snapshot timestamp than when it was quarantined
      if (!force && quarantinedMap.has(id)) {
        const quarantinedAt = quarantinedMap.get(id) ?? 0
        if (serverTime <= quarantinedAt) {
          continue
        }
      }

      const localTime = localLastModifiedMap.get(id) ?? 0

      if (isDeleted) {
        if (knownSet.has(id)) {
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

      if (localTime === 0) {
        missingIds.push(id)
        continue
      }
      if (force && !knownSet.has(id)) {
        missingIds.push(id)
        continue
      }
      if (serverTime === localTime) continue
      if (serverTime > localTime) {
        missingIds.push(id)
        continue
      }

      // Clock skew + buffer compensation for cases where client clock was ahead
      const adjustedLocalTime = localTime - Math.max(0, clockSkew) - SKEW_BUFFER_MS
      if (serverTime > adjustedLocalTime) {
        missingIds.push(id)
        continue
      }
    }

    // Apply any local tombstones discovered from server manifest
    if (locallyTombstonedSnapshots.length > 0) {
      await this.storeItems(locallyTombstonedSnapshots, { markDirty: false })
    }

    if (deletedLastModifiedUpdates.length > 0) {
      await this.deps.snapshotManager.importLastModified(deletedLastModifiedUpdates)
    }

    // Two-Way Manifest Reconciliation (Upstream):
    // Identify local items that need to be pushed as snapshots to the server.
    // Exclude items that were just locally tombstoned.
    const missingSet = new Set(missingIds)
    const locallyTombstonedSet = new Set(locallyTombstonedSnapshots.map(s => s.id as ItemId))
    const upstreamIds: ItemId[] = []
    for (const localId of knownItemIds) {
      if (missingSet.has(localId) || locallyTombstonedSet.has(localId)) continue
      const serverTime = serverManifestMap.get(localId)
      const localTime = localLastModifiedMap.get(localId) ?? 0

      if (serverTime === undefined) {
        // Item exists locally but is completely missing from server manifest
        upstreamIds.push(localId)
      } else {
        // Clock skew + buffer compensation: if local time exceeds server time
        const adjustedLocalTime = localTime - Math.max(0, clockSkew) - SKEW_BUFFER_MS
        if (adjustedLocalTime > serverTime) {
          upstreamIds.push(localId)
        }
      }
    }

    if (upstreamIds.length > 0) {
      for (const id of upstreamIds) {
        this.deps.snapshotManager.markItemDirty(id, UPSTREAM_SNAPSHOT_DEBOUNCE_MS)
      }
    }

    if (missingIds.length === 0) {
      await this.hydrateMetadata()
      await this.deps.indexManager.updateLastManifestSyncTime(Date.now())
      return { added: [] }
    }

    // Fetch missing item snapshots in batches of 50
    const batches = chunk(missingIds, BATCH_SIZE)
    const fetchedItems: VaultItem[] = []
    let hasBatchFailures = false

    for (const batch of batches) {
      try {
        const response = await fetchSnapshotsByIds({
          account: this.deps.accountId,
          itemIds: batch,
        })
        if (response?.items && Array.isArray(response.items)) {
          fetchedItems.push(...response.items)
        } else {
          hasBatchFailures = true
        }
      } catch (error) {
        hasBatchFailures = true
        console.error('[ManifestSyncManager] Failed to fetch snapshot batch', {
          batch,
          error,
        })
      }
    }

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

    const promises = validFetchedItems.map(async item => {
      try {
        const manifestEntry = manifestResponse.manifest.find(([id]) => id === item.item)
        const serverTime = manifestEntry ? manifestEntry[1] : manifestResponse.serverTime
        const itemId = item.item

        if (item.metadata?.deleted === true) {
          snapshots.push({ id: item.item, deleted: true } as unknown as Item)
          lastModifiedUpdates.push([itemId, serverTime])
          return
        }

        let decryptedSuccessfully = false

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
            hydratedIds.push(itemId)
            if (hydrationResult?.hasLocalChanges) {
              this.deps.snapshotManager.markItemDirty(itemId, UPSTREAM_SNAPSHOT_DEBOUNCE_MS)
            } else {
              lastModifiedUpdates.push([itemId, serverTime])
            }
            decryptedSuccessfully = true
            return
          }
        }

        if (
          !decryptedSuccessfully &&
          typeof item.cipher === 'string' &&
          item.cipher.length > 0 &&
          typeof item.metadata?.iv === 'string' &&
          item.metadata.iv.length > 0
        ) {
          const kver = (item.metadata as Record<string, unknown> | undefined)?.kver as string | undefined
          if (kver && !hasVaultKey(kver)) {
            await waitForKeyVersion(kver, 3000)
          }
          const decrypted = await decryptObject({
            iv: item.metadata.iv,
            cipher: item.cipher,
            kver,
          }).catch(() => null)

          if (decrypted && typeof decrypted === 'object' && !Array.isArray(decrypted)) {
            const snapshot = { ...(decrypted as Record<string, unknown>) }
            if (!snapshot.id || typeof snapshot.id !== 'string') {
              snapshot.id = item.item
            }
            snapshots.push(snapshot as Item)
            lastModifiedUpdates.push([snapshot.id as ItemId, serverTime])
            decryptedSuccessfully = true
            return
          }
        }

        if (!decryptedSuccessfully) {
          hasHydrationFailures = true
          console.warn(
            `[ManifestSyncManager] Item ${itemId} could not be decrypted; quarantining to manual recovery`
          )
          this.onDecryptionFailure?.(itemId, new Error('Failed to decrypt snapshot binary or legacy cipher'))
        }
      } catch (error) {
        hasHydrationFailures = true
        console.error('[ManifestSyncManager] Failed to hydrate fetched item envelope', {
          itemId: item.item,
          error,
        })
      }
    })

    await Promise.allSettled(promises)

    if (hydratedIds.length > 0) {
      await this.deps.indexManager.addAutomergeItemIdsToIndex(hydratedIds)
    }

    if (snapshots.length > 0) {
      await this.storeItems(snapshots, { markDirty: false })
    }

    if (lastModifiedUpdates.length > 0) {
      await this.deps.snapshotManager.importLastModified(lastModifiedUpdates)
    }

    await this.hydrateMetadata()

    if (!hasBatchFailures && !hasHydrationFailures) {
      await this.deps.indexManager.updateLastManifestSyncTime(Date.now())
    } else {
      console.warn(
        '[ManifestSyncManager] Some batches or items failed to sync; lastManifestSyncTime not updated to allow retry'
      )
    }

    return { added: hydratedIds }
  }

  private async decryptSnapshotBinary(
    encryptedAutomergeDoc: CryptoResult,
  ): Promise<Uint8Array | null> {
    try {
      if (encryptedAutomergeDoc.kver && !hasVaultKey(encryptedAutomergeDoc.kver)) {
        await waitForKeyVersion(encryptedAutomergeDoc.kver, 3000)
      }
      return await decryptBytes(encryptedAutomergeDoc)
    } catch {
      return null
    }
  }

  private async hydrateMetadata() {
    if (!hasApiAuthToken()) return

    const localMetadata = await this.deps.indexManager.getAutomergeMetadata()
    if (Object.keys(localMetadata || {}).length > 0) return

    const response = await Promise.resolve(
      getTrpcClient().accounts.getMetadata.query({ account: this.deps.accountId })
    ).catch(() => null)
    if (
      response?.success &&
      !!response.metadata &&
      typeof response.metadata === 'object' &&
      !Array.isArray(response.metadata)
    ) {
      try {
        await this.mutateMetadata(response.metadata as AccountMetadata)
      } catch (error) {
        console.error('[ManifestSyncManager] Metadata hydration skipped', error)
      }
    }
  }
}
