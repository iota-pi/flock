import { chunk } from 'lodash-es'

import type { VaultDoc } from '../shared/types'
import type { AutomergeDocStore, AutomergeIndexManager } from './docStore'
import type { SnapshotManager } from './SnapshotManager'
import type { CryptoResult } from '../../api/vault/crypto'
import type { KeyProvider } from '../../api/vault/Keyring'
import { decryptWithKeyResolution } from './utils/decryptWithKeyResolution'
import type { ItemId } from 'src/shared/vault/ids'
import type { SyncApiClient } from './SyncApiClient'
import type { VaultItem } from '../../api/vault/clientTypes'
import type { StoreItemsOptions } from './ItemOperations'
import { checkAlive, isAbortError } from '../utils/abort'
import type { ManifestEntry } from 'src/shared/vault/api'
import { mapWithConcurrency } from '../../shared/vault/concurrency'
import { SYNC_BATCH_SIZES } from '../syncConfig'
import type { LegacyItemEnvelope, SyncDomain } from './domain'

const BATCH_SIZE = 50
const UPSTREAM_SNAPSHOT_DEBOUNCE_MS = 2000
const KEY_WAIT_TIMEOUT_MS = 3000

export type HydrateItemResult =
  | {
    status: 'success'
    itemId: ItemId
    hydratedId?: ItemId
    snapshot?: VaultDoc
    /** Content decoded from a legacy format, which has to be uploaded as a snapshot */
    legacySnapshot?: VaultDoc
    lastModifiedUpdate?: [ItemId, number]
    versionUpdate?: [ItemId, number]
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
  keys: KeyProvider
  storeItems: (items: VaultDoc[], options?: StoreItemsOptions) => Promise<void>
  onDecryptionFailure?: (itemId: ItemId, error: unknown) => void
  onItemSnapshotHydrated?: (itemId: ItemId, heads: string[]) => void
  onKeyVersionMissing?: (kver: string) => void
  isShutdown?: () => boolean
  hydrationConcurrency?: number
  decodeLegacyItem?: SyncDomain['decodeLegacyItem']
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

    const snapshots: VaultDoc[] = []
    const legacySnapshots: VaultDoc[] = []
    const hydratedIds: ItemId[] = []
    const lastModifiedUpdates: [ItemId, number][] = []
    const versionUpdates: [ItemId, number][] = []
    let hasHydrationFailures = false

    const hydrationConcurrency = this.deps.hydrationConcurrency ?? SYNC_BATCH_SIZES.hydrationConcurrency

    const results = await mapWithConcurrency(
      validFetchedItems,
      hydrationConcurrency,
      async item => {
        checkAlive(signal, () => this.isAlive())
        try {
          const value = await this.hydrateRemoteItem(
            item,
            params.manifest,
            params.knownSet,
            params.tombstoneSet,
            params.serverTime,
          )
          return { status: 'fulfilled' as const, value }
        } catch (reason) {
          if (signal?.aborted || isAbortError(reason)) {
            throw reason
          }
          return { status: 'rejected' as const, reason }
        }
      },
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
          if (result.legacySnapshot) {
            legacySnapshots.push(result.legacySnapshot)
          }
          if (result.lastModifiedUpdate) {
            lastModifiedUpdates.push(result.lastModifiedUpdate)
          }
          if (result.versionUpdate) {
            versionUpdates.push(result.versionUpdate)
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

    if (legacySnapshots.length > 0) {
      await this.deps.storeItems(legacySnapshots, { markDirty: true })
    }

    if (lastModifiedUpdates.length > 0) {
      await this.deps.snapshotManager.importLastModified(lastModifiedUpdates)
    }

    if (versionUpdates.length > 0) {
      await this.deps.snapshotManager.importVersions(versionUpdates)
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
      const manifestEntry = manifest.find(entry => entry.itemId === item.item)
      const serverTime = manifestEntry?.modifiedAt ?? serverTimeFallback
      const serverVersion = (manifestEntry?.version && manifestEntry.version > 0)
        ? manifestEntry.version
        : (
          typeof (item as unknown as { version?: unknown }).version === 'number'
            ? (item as unknown as { version: number }).version
            : 1
        )

      if (item.metadata?.deleted === true) {
        return {
          status: 'success',
          itemId,
          snapshot: { id: item.item, deleted: true },
          lastModifiedUpdate: [itemId, serverTime],
          versionUpdate: [itemId, serverVersion],
        }
      }

      if (item.snapshot) {
        const binaryResult = await this.hydrateSnapshotBinary(
          itemId,
          item,
          serverTime,
          serverVersion,
          knownSet,
          tombstoneSet,
        )
        if (binaryResult) {
          return binaryResult
        }
        // Never fall back to a legacy payload: decoded items are uploaded, which would replace the
        // newer snapshot with older content
        return {
          status: 'decryption_failure',
          itemId,
          error: new Error('Failed to decrypt snapshot binary'),
        }
      }

      const legacyResult = await this.hydrateLegacyItem(
        itemId,
        item,
        serverTime,
        serverVersion,
        tombstoneSet,
      )
      if (legacyResult) {
        return legacyResult
      }

      return {
        status: 'decryption_failure',
        itemId,
        error: new Error('Item has no snapshot and no legacy payload the app could decode'),
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
    serverVersion: number,
    knownSet: Set<ItemId>,
    tombstoneSet: Set<ItemId>,
  ): Promise<HydrateItemResult | null> {
    if (!item.snapshot) return null
    const binary = await this.decryptSnapshotBinary(itemId, item.snapshot)
    if (!binary) return null

    const hydrationResult = await this.deps.docStore.hydrateAutomergeDocumentBinary(item.item, binary, {
      knownToExist: knownSet.has(itemId),
    })
    try {
      const heads = hydrationResult?.incomingHeads
      if (heads) {
        this.deps.onItemSnapshotHydrated?.(itemId, heads)
      }
    } catch {
      // Best-effort heads notification; ignore failure if notification throws
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
      versionUpdate: [itemId, serverVersion],
    }
  }

  private async hydrateLegacyItem(
    itemId: ItemId,
    item: VaultItem,
    serverTime: number,
    serverVersion: number,
    tombstoneSet: Set<ItemId>,
  ): Promise<HydrateItemResult | null> {
    if (!this.deps.decodeLegacyItem) return null
    const decoded = await this.deps.decodeLegacyItem(
      item as unknown as LegacyItemEnvelope,
      {
        ensureKey: kver => this.ensureKey(kver),
        decrypt: payload => this.deps.keys.decryptBytes(payload),
      },
    ).catch(() => null)
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
      return null
    }

    const snapshot = { ...decoded }
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
        versionUpdate: [snapshotId, serverVersion],
      }
    }
    return {
      status: 'success',
      itemId,
      legacySnapshot: snapshot as VaultDoc,
      lastModifiedUpdate: [snapshotId, serverTime],
      versionUpdate: [snapshotId, serverVersion],
    }
  }

  private async ensureKey(kver: string): Promise<boolean> {
    if (this.deps.keys.hasKey(kver)) return true
    this.deps.onKeyVersionMissing?.(kver)
    return this.deps.keys.waitForKey(kver, KEY_WAIT_TIMEOUT_MS)
  }

  private async decryptSnapshotBinary(
    itemId: ItemId,
    encryptedAutomergeDoc: CryptoResult,
  ): Promise<Uint8Array | null> {
    try {
      return await decryptWithKeyResolution(this.deps.keys, encryptedAutomergeDoc, {
        docId: itemId,
        timeoutMs: KEY_WAIT_TIMEOUT_MS,
        onKeyVersionMissing: this.deps.onKeyVersionMissing,
      })
    } catch {
      return null
    }
  }
}
