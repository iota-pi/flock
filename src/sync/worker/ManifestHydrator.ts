import { chunk } from 'lodash-es'
import * as Automerge from '@automerge/automerge/slim'

import type { Item } from '../../state/items'
import type { AutomergeDocStore, AutomergeIndexManager } from './docStore'
import type { SnapshotManager } from './SnapshotManager'
import { decryptObject, hasVaultKey, waitForKeyVersion, type CryptoResult } from '../../api/vault'
import { decryptWithKeyResolution } from './utils/decryptWithKeyResolution'
import type { ItemId } from 'src/shared/schemas/items'
import type { SyncApiClient } from './SyncApiClient'
import type { VaultItem } from '../../api/vault/clientTypes'
import type { StoreItemsOptions } from './ItemOperations'
import { checkAlive, isAbortError } from './utils/abort'
import type { ManifestEntry } from './ManifestDeltaCalculator'

const BATCH_SIZE = 50
const UPSTREAM_SNAPSHOT_DEBOUNCE_MS = 2000
const KEY_WAIT_TIMEOUT_MS = 3000

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

export interface FetchAndHydrateParams {
  missingIds: ItemId[]
  manifest: ManifestEntry[]
  serverTime: number
  knownSet: Set<ItemId>
  tombstoneSet: Set<ItemId>
}

export interface ManifestHydratorDeps {
  accountId: string
  apiClient: SyncApiClient
  docStore: AutomergeDocStore
  indexManager: AutomergeIndexManager
  snapshotManager: SnapshotManager
  storeItems: (items: Item[], options?: StoreItemsOptions) => Promise<void>
  onDecryptionFailure?: (itemId: ItemId, error: unknown) => void
  onItemSnapshotHydrated?: (itemId: ItemId, heads: string[]) => void
  onKeyVersionMissing?: (kver: string) => void
  isShutdown?: () => boolean
}

export class ManifestHydrator {
  constructor(private readonly deps: ManifestHydratorDeps) {}

  private isAlive(): boolean {
    return this.deps.isShutdown ? !this.deps.isShutdown() : true
  }

  async fetchAndHydrateRemoteItems(
    params: FetchAndHydrateParams,
    signal?: AbortSignal,
  ): Promise<{ added: ItemId[]; hasFailures: boolean }> {
    const batches = chunk(params.missingIds, BATCH_SIZE)
    const fetchedItems: VaultItem[] = []
    let hasBatchFailures = false

    for (const batch of batches) {
      checkAlive(signal, () => this.isAlive())
      try {
        const response = await this.deps.apiClient.fetchSnapshotsByIds(
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
        console.error('[ManifestHydrator] Failed to fetch snapshot batch', {
          batch,
          error,
        })
      }
    }

    checkAlive(signal, () => this.isAlive())

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
        console.error('[ManifestHydrator] Unexpected error hydrating item', settled.reason)
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
            `[ManifestHydrator] Item ${result.itemId} could not be decrypted; quarantining to manual recovery`,
          )
          this.deps.onDecryptionFailure?.(result.itemId, result.error)
          break
        case 'error':
          hasHydrationFailures = true
          console.error('[ManifestHydrator] Failed to hydrate fetched item envelope', {
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
      await this.deps.storeItems(snapshots, { markDirty: false })
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
        const binaryResult = await this.hydrateSnapshotBinary(itemId, item, serverTime, knownSet, tombstoneSet)
        if (binaryResult) {
          return binaryResult
        }
      }

      const legacyResult = await this.hydrateLegacyCipher(itemId, item, serverTime, tombstoneSet)
      if (legacyResult) {
        return legacyResult
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

  private async hydrateSnapshotBinary(
    itemId: ItemId,
    item: VaultItem,
    serverTime: number,
    knownSet: Set<ItemId>,
    tombstoneSet: Set<ItemId>,
  ): Promise<HydrateItemResult | null> {
    if (!item.snapshot) return null
    const binary = await this.decryptSnapshotBinary(item.snapshot)
    if (!binary) return null

    const hydrationResult = await this.deps.docStore.hydrateAutomergeDocumentBinary(item.item, binary, {
      knownToExist: knownSet.has(itemId),
    })
    try {
      const heads = hydrationResult?.incomingHeads ?? Automerge.getHeads(Automerge.load(binary))
      this.deps.onItemSnapshotHydrated?.(itemId, heads)
    } catch {
      // Best-effort heads notification; ignore failure if binary cannot be inspected
    }

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

  private async hydrateLegacyCipher(
    itemId: ItemId,
    item: VaultItem,
    serverTime: number,
    tombstoneSet: Set<ItemId>,
  ): Promise<HydrateItemResult | null> {
    const decryptedLegacy = await this.decryptLegacyCipher(item)
    if (!decryptedLegacy || typeof decryptedLegacy !== 'object' || Array.isArray(decryptedLegacy)) {
      return null
    }

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
      await waitForKeyVersion(kver, KEY_WAIT_TIMEOUT_MS)
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
        timeoutMs: KEY_WAIT_TIMEOUT_MS,
        onKeyVersionMissing: this.deps.onKeyVersionMissing,
      })
    } catch {
      return null
    }
  }
}
