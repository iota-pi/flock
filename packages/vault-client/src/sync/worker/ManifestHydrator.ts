import { chunk } from 'lodash-es'

import type { VaultDoc } from '../shared/types'
import type { AutomergeDocStore, AutomergeIndexManager } from './docStore'
import type { SnapshotManager } from './SnapshotManager'
import type { CryptoResult } from '../../api/crypto'
import type { KeyProvider } from '../../api/Keyring'
import { decryptWithKeyResolution } from './utils/decryptWithKeyResolution'
import type { FetchedItem, ItemId, ManifestEntry } from '@vault/shared'
import type { SyncApiClient } from './SyncApiClient'
import type { StoreItemsOptions } from './ItemOperations'
import { checkAlive, isAbortError } from '../utils/abort'
import { classifySyncError } from '../utils/errorClassifier'
import { mapWithConcurrency } from '@vault/shared'
import { SYNC_BATCH_SIZES, SYNC_TIMEOUTS } from '../shared/syncConfig'
import type { SyncDomain } from './domain'
import { createLogger } from '../utils/logger'

const log = createLogger('ManifestHydrator')

const BATCH_SIZE = 50
const UPSTREAM_SNAPSHOT_DEBOUNCE_MS = SYNC_TIMEOUTS.upstreamSnapshotDebounce
const KEY_WAIT_TIMEOUT_MS = SYNC_TIMEOUTS.hydrationKeyWait

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
  | {
    /**
     * The snapshot's key version isn't loaded yet, or the vault is locked. Not a corrupt item: it is
     * fetched again at the next manifest sync.
     */
    status: 'key_unavailable'
    itemId: ItemId
  }
  | {
    /** A legacy row, and the app has no `decodeLegacyItem` hook: only its migration app can read it */
    status: 'migration_required'
    itemId: ItemId
  }

interface FetchAndHydrateParams {
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
  /**
   * Called once per batch that contains legacy rows when there is no `decodeLegacyItem` hook. Such
   * rows are skipped rather than quarantined, so the app's migration app can still decode them.
   */
  onMigrationRequired?: () => void
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
    const fetchedItems: FetchedItem[] = []
    let hasBatchFailures = false

    for (const batch of batches) {
      checkAlive(signal, () => this.isAlive())
      try {
        const response = await this.deps.apiClient.fetchSnapshotsByIds(
          {
            account: this.deps.accountId,
            itemIds: batch,
          },
          { signal },
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
        log.error('Failed to fetch snapshot batch', {
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
    let hasMigrationRequired = false

    const hydrationConcurrency = this.deps.hydrationConcurrency ?? SYNC_BATCH_SIZES.hydrationConcurrency
    const manifestById = new Map(params.manifest.map(entry => [entry.itemId, entry]))

    const results = await mapWithConcurrency(
      validFetchedItems,
      hydrationConcurrency,
      // hydrateRemoteItem catches its own errors, so only an abort from checkAlive rejects here
      item => {
        checkAlive(signal, () => this.isAlive())
        return this.hydrateRemoteItem(
          item,
          manifestById,
          params.knownSet,
          params.tombstoneSet,
          params.serverTime,
        )
      },
    )

    for (const result of results) {
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
          log.warn(
            `Item ${result.itemId} could not be decrypted; quarantining to manual recovery`,
          )
          this.deps.onDecryptionFailure?.(result.itemId, result.error)
          break
        case 'error':
          hasHydrationFailures = true
          log.error('Failed to hydrate fetched item envelope', {
            itemId: result.itemId,
            error: result.error,
          })
          break
        case 'key_unavailable':
          // Not quarantined, and this sync doesn't count as complete, so the next one fetches it again
          hasHydrationFailures = true
          log.warn(`Item ${result.itemId} waits for its key; will retry at the next sync`)
          break
        case 'migration_required':
          // Not synced, so this sync must not count as complete (see DataVersionTracker)
          hasHydrationFailures = true
          hasMigrationRequired = true
          break
      }
    }

    if (hasMigrationRequired) {
      this.deps.onMigrationRequired?.()
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
    item: FetchedItem,
    manifestById: ReadonlyMap<ItemId, ManifestEntry>,
    knownSet: Set<ItemId>,
    tombstoneSet: Set<ItemId> = new Set(),
    serverTimeFallback: number = Date.now(),
  ): Promise<HydrateItemResult> {
    const itemId = item.item as ItemId
    try {
      const manifestEntry = manifestById.get(itemId)
      const serverTime = manifestEntry?.modifiedAt ?? serverTimeFallback
      const serverVersion = (manifestEntry?.version && manifestEntry.version > 0)
        ? manifestEntry.version
        : (item.version ?? 1)

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
          item.snapshot,
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

      if (!this.deps.decodeLegacyItem) {
        return { status: 'migration_required', itemId }
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
    snapshot: CryptoResult,
    serverTime: number,
    serverVersion: number,
    knownSet: Set<ItemId>,
    tombstoneSet: Set<ItemId>,
  ): Promise<HydrateItemResult | null> {
    const binary = await this.decryptSnapshotBinary(itemId, snapshot)
    if (binary === 'key_unavailable') return { status: 'key_unavailable', itemId }
    if (!binary) return null

    const hydrationResult = await this.deps.docStore.hydrateAutomergeDocumentBinary(itemId, binary, {
      knownToExist: knownSet.has(itemId),
    })
    const heads = hydrationResult?.incomingHeads
    if (heads) {
      try {
        this.deps.onItemSnapshotHydrated?.(itemId, heads)
      } catch {
        // Best-effort: the doc is already hydrated, so a failed notification mustn't fail the item
      }
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
    item: FetchedItem,
    serverTime: number,
    serverVersion: number,
    tombstoneSet: Set<ItemId>,
  ): Promise<HydrateItemResult | null> {
    const decodeLegacyItem = this.deps.decodeLegacyItem
    if (!decodeLegacyItem) return null
    const decoded = await decodeLegacyItem(
      item,
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

  /** Returns null when the snapshot can't be decrypted, and 'key_unavailable' when that may be temporary */
  private async decryptSnapshotBinary(
    itemId: ItemId,
    encryptedAutomergeDoc: CryptoResult,
  ): Promise<Uint8Array | 'key_unavailable' | null> {
    try {
      return await decryptWithKeyResolution(this.deps.keys, encryptedAutomergeDoc, {
        docId: itemId,
        timeoutMs: KEY_WAIT_TIMEOUT_MS,
        onKeyVersionMissing: this.deps.onKeyVersionMissing,
      })
    } catch (error) {
      const classified = classifySyncError(error)
      return classified.isMissingKey || classified.isTransientVault ? 'key_unavailable' : null
    }
  }
}
