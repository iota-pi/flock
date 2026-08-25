import { chunk } from 'lodash-es'
import type { Item } from '../../state/items'
import type { AccountMetadata } from '../../state/metadata'
import { AutomergeDocStore } from './docStore'
import { AutomergeIndexManager } from './docStore/AutomergeIndexManager'
import type { SnapshotManager } from './SnapshotManager'
import { fetchManifest, fetchSnapshotsByIds } from '../../api/vault/ItemClient'
import { decryptObject, decryptBytes, type CryptoResult } from '../../api/vault'
import { hasApiAuthToken } from '../../api/runtime'
import type { ItemId } from 'src/shared/schemas/items'
import { getTrpcClient } from 'src/api/trpcClient'
import type { VaultItem } from '../../api/vault/clientTypes'

const ONE_DAY_MS = 24 * 60 * 60 * 1000
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
const BATCH_SIZE = 50

export class ManifestSyncManager {
  constructor(
    private deps: {
      accountId: string
      docStore: AutomergeDocStore
      indexManager: AutomergeIndexManager
      snapshotManager: SnapshotManager
    },
    private storeItems: (items: Item[]) => Promise<void>,
    private mutateMetadata: (changes: Partial<AccountMetadata>) => Promise<void>
  ) {}

  async sync(force = false): Promise<{ added: ItemId[] }> {
    if (!this.deps.accountId) return { added: [] }

    const knownItemIds = await this.deps.indexManager.listAutomergeItemIds()
    const lastManifestSyncTime = await this.deps.indexManager.getLastManifestSyncTime()

    const hasKnownItems = knownItemIds.length > 0
    const timeSinceLastSync = lastManifestSyncTime > 0 ? Date.now() - lastManifestSyncTime : Infinity

    // Gating logic:
    // - Force runs unconditionally
    // - If it has been more than 7 days, always run (even if not forced)
    // - If we already have items and last run was less than 24 hours ago, skip
    const isOfflineTooLong = timeSinceLastSync >= SEVEN_DAYS_MS
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
    try {
      manifestResponse = await fetchManifest({
        account: this.deps.accountId,
      })
    } catch (e) {
      if (hasKnownItems) {
        console.warn('[ManifestSyncManager] Failed to fetch manifest, falling back to local data', e)
        return { added: [] }
      }
      console.error('[ManifestSyncManager] Failed to fetch manifest', e)
      throw new Error(`[ManifestSyncManager] Failed to fetch manifest: ${(e as Error).message || String(e)}`, { cause: e })
    }

    const knownSet = new Set(knownItemIds)
    const localLastModifiedMap = new Map(this.deps.snapshotManager.exportLastModified())

    const missingIds = manifestResponse.manifest
      .filter(([itemId, serverTime]) => {
        const id = itemId as ItemId
        if (!id) return false
        if (!knownSet.has(id)) return true
        const localTime = localLastModifiedMap.get(id) ?? 0
        return serverTime > localTime
      })
      .map(([itemId]) => itemId as ItemId)

    if (missingIds.length === 0) {
      await this.hydrateMetadata()
      await this.deps.indexManager.updateLastManifestSyncTime(Date.now())
      return { added: [] }
    }

    // Fetch missing item snapshots in batches of 50
    const batches = chunk(missingIds, BATCH_SIZE)
    const fetchedItems: VaultItem[] = []

    for (const batch of batches) {
      try {
        const response = await fetchSnapshotsByIds({
          account: this.deps.accountId,
          itemIds: batch,
        })
        if (response.items && Array.isArray(response.items)) {
          fetchedItems.push(...response.items)
        }
      } catch (error) {
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

    const promises = validFetchedItems.map(async item => {
      try {
        const manifestEntry = manifestResponse.manifest.find(([id]) => id === item.item)
        const serverTime = manifestEntry ? manifestEntry[1] : Date.now()

        if (item.metadata?.deleted === true) {
          snapshots.push({ id: item.item, deleted: true } as unknown as Item)
          lastModifiedUpdates.push([item.item as ItemId, serverTime])
          return
        }

        if (item.snapshot) {
          const binary = await this.decryptSnapshotBinary(item.snapshot)
          if (binary) {
            await this.deps.docStore.hydrateAutomergeDocumentBinary(item.item, binary)
            hydratedIds.push(item.item as ItemId)
            lastModifiedUpdates.push([item.item as ItemId, serverTime])
            return
          }
        }

        if (
          typeof item.cipher === 'string' &&
          item.cipher.length > 0 &&
          typeof item.metadata?.iv === 'string' &&
          item.metadata.iv.length > 0
        ) {
          const decrypted = await decryptObject({
            iv: item.metadata.iv,
            cipher: item.cipher,
          }).catch(() => null)

          if (decrypted && typeof decrypted === 'object' && !Array.isArray(decrypted)) {
            const snapshot = { ...(decrypted as Record<string, unknown>) }
            if (!snapshot.id || typeof snapshot.id !== 'string') {
              snapshot.id = item.item
            }
            snapshots.push(snapshot as Item)
            lastModifiedUpdates.push([snapshot.id as ItemId, serverTime])
          }
        }
      } catch (error) {
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
      await this.storeItems(snapshots)
    }

    if (lastModifiedUpdates.length > 0) {
      const currentLastModified = new Map(this.deps.snapshotManager.exportLastModified())
      for (const [id, time] of lastModifiedUpdates) {
        currentLastModified.set(id, time)
      }
      await this.deps.snapshotManager.importLastModified(Array.from(currentLastModified.entries()))
    }

    await this.hydrateMetadata()
    await this.deps.indexManager.updateLastManifestSyncTime(Date.now())

    return { added: hydratedIds }
  }

  private async decryptSnapshotBinary(
    encryptedAutomergeDoc: CryptoResult,
  ): Promise<Uint8Array | null> {
    try {
      return decryptBytes(encryptedAutomergeDoc)
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
