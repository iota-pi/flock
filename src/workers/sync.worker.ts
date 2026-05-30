/* eslint-disable @typescript-eslint/no-explicit-any */
/// <reference lib="webworker" />
import * as Comlink from 'comlink'
import * as Automerge from '@automerge/automerge/slim'
import wasmUrl from '@automerge/automerge/automerge.wasm?url'
import type { SyncApi, SyncCallbacks } from './syncProtocol'
import type { Item } from '../state/items'
import type { AccountMetadata } from '../state/metadata'
import {
  initializeAutomergeDocStore,
  getAutomergeMetadata,
  withAutomergeDocumentChange,
  withAutomergeMetadataChange,
  removeAutomergeItem,
  getAutomergeItem,
  ACCOUNT_INDEX_DOCUMENT_ID,
  removeAutomergeItemIdsFromIndex,
  addAutomergeItemIdsToIndex,
  clearAutomergeDocStore,
  exportAllBinaries,
  restoreFromBinaries,
  AutomergeIndexDocument,
  normalizeItemSnapshot,
  hydrateAutomergeDocumentBinary,
  listAutomergeItemIds,
} from '../sync/automergeDocStore'
import { fetchMany } from '../api/vault/ItemClient'
import { CryptoResult, decryptObject, getVaultKey, initWorkerVault } from '../api/vault'
import { hasApiAuthToken } from '../api/runtime'
import { trpcClient } from '../api/trpcClient'
import type { VaultSnapshotInput } from '../shared/schemas/snapshots'
import { initAutomergeRepo } from '../sync/automergeRepo'
import { toAutomergeUrlFromItemId } from '../sync/automergeRepoIds'
import type { Repo } from '@automerge/automerge-repo/slim'
import { VaultEncryptedNetworkAdapter } from 'src/sync/VaultEncryptedNetworkAdapter'
import { getActiveSessionToken } from '../sync/workerAuthStore'
import { putSnapshotsWithToken } from '../api/vault/SyncWorkerClient'
import { ITEM_TYPES } from '../shared/itemTypes'
import {
  type ManualRecoveryEntry,
  readManualRecoveryEntries,
  removeManualRecoveryEntryById,
  removeManualRecoveryEntryByItemId,
} from '../sync/manualRecoveryStore'
import { decryptBytesWithKey, encryptBytesWithKey } from 'src/api/vault/crypto'

function mutateDraftToMatchSnapshot(
  draft: Record<string, unknown>,
  snapshot: Record<string, unknown>,
): void {
  for (const key of Object.keys(draft)) {
    if (!(key in snapshot) || snapshot[key] === undefined) {
      delete draft[key]
    }
  }

  for (const [key, value] of Object.entries(snapshot)) {
    if (value !== undefined) {
      draft[key] = value
    }
  }
}

function normalizeSnapshotType(type: Item['type'], originalType?: Item['type']): string {
  const resolvedType = (
    (type === 'error' && originalType) ? originalType : type
  )
  const isValidType = ITEM_TYPES.includes(resolvedType as (typeof ITEM_TYPES)[number])
  return isValidType
    ? resolvedType
    : 'person'
}

class SyncWorker implements SyncApi {
  private accountId: string | null = null
  private adapter: VaultEncryptedNetworkAdapter | null = null
  private callbacks: SyncCallbacks | null = null
  private subscribedHandles = new Set<string>()
  private repo: Repo | null = null
  private dirtyDocuments = new Set<string>()
  private snapshotPushInFlight = false
  private snapshotPushPending = false
  private snapshotRequestCursor: number | null = null

  async initRepo(accountId: string, vaultKey: string, callbacks: SyncCallbacks) {
    this.accountId = accountId
    this.callbacks = callbacks

    await initWorkerVault(vaultKey)

    // Load Automerge WASM module
    await Automerge.initializeWasm(wasmUrl)

    // Initialise Automerge repo
    this.adapter = new VaultEncryptedNetworkAdapter()
    this.adapter.onStartRequest = callbacks.onStartRequest
    this.adapter.onFinishRequest = callbacks.onFinishRequest
    this.adapter.onSnapshotNeeded = (cursor: number, _requestedAt: number) => this.scheduleSnapshotPush(cursor)
    this.adapter.setAccount(accountId)
    const repo = initAutomergeRepo(accountId, this.adapter)
    this.repo = repo
    await initializeAutomergeDocStore(accountId)

    const indexUrl = toAutomergeUrlFromItemId(ACCOUNT_INDEX_DOCUMENT_ID)
    const indexHandle = await repo.find<AutomergeIndexDocument>(indexUrl)
    if (!indexHandle) return
    await indexHandle.whenReady(['ready', 'unavailable'])

    const handleIndexChange = () => {
      const indexDoc = indexHandle.doc()
      if (!indexDoc) return
      const newItemIds = indexDoc.itemIds || []
      if (this.callbacks) {
        this.callbacks.onIndexUpdated(newItemIds).catch(console.error)

        const newMetadata = indexDoc.metadata || {}
        this.callbacks.onMetadataUpdated(newMetadata).catch(console.error)
      }

      this.subscribeToItems(newItemIds, repo)
    }

    indexHandle.on('change', handleIndexChange)
    handleIndexChange()

    await this.callbacks.onReady()
  }

  private markDocumentDirty(documentId: string) {
    if (!documentId) return
    this.dirtyDocuments.add(documentId)
  }

  private scheduleSnapshotPush(cursor: number) {
    this.snapshotRequestCursor = cursor
    if (this.snapshotPushInFlight) {
      this.snapshotPushPending = true
      return
    }

    void this.pushSnapshots()
  }

  async bootstrapLegacyItems() {
    if (!this.accountId) return

    const knownItemIds = listAutomergeItemIds(this.accountId)
    if (knownItemIds.length > 0) return

    if (!hasApiAuthToken()) {
      throw new Error('[sync.worker] No API auth token found, cannot bootstrap legacy items')
    }

    const response = await fetchMany({
      account: this.accountId,
    }).catch(e => {
      console.error('[sync.worker] failed to fetch item snapshots', e)
      return { items: [] as any[] }
    })

    const fetchedItems = response.items.filter((entry: any) => entry && typeof entry === 'object' && typeof entry.item === 'string' && entry.item.length > 0)

    if (fetchedItems.length === 0) return

    const snapshots: Item[] = []

    const promises = fetchedItems.map(async (item: any) => {
      try {
        if (item.metadata?.deleted === true) {
          snapshots.push({ id: item.item, deleted: true } as unknown as Item)
          return
        }

        if (item.snapshot) {
          const binary = await this.decryptSnapshotBinary(item.snapshot)
          if (binary) {
            await hydrateAutomergeDocumentBinary(this.accountId!, item.item, binary)
            return
          }
        }

        if (typeof item.cipher === 'string' && item.cipher.length > 0 && typeof item.metadata?.iv === 'string' && item.metadata.iv.length > 0) {
          const decrypted = await decryptObject({ iv: item.metadata.iv, cipher: item.cipher }).catch(() => null)
          if (decrypted && typeof decrypted === 'object' && !Array.isArray(decrypted)) {
            const snapshot = { ...(decrypted as Record<string, unknown>) }
            if (!snapshot.id || typeof snapshot.id !== 'string') {
              snapshot.id = item.item
            }
            snapshots.push(snapshot as Item)
          }
        }
      } catch (error) {
        console.error('[sync.worker] failed to hydrate fetched item envelope', { itemId: item.item, error })
      }
    })

    await Promise.allSettled(promises)

    if (snapshots.length > 0) {
      await this.storeItems(snapshots)
    }

    await this.hydrateMetadata()
  }

  private async decryptSnapshotBinary(encryptedAutomergeDoc: CryptoResult): Promise<Uint8Array | null> {
    try {
      return decryptBytesWithKey(getVaultKey(), encryptedAutomergeDoc)
    } catch {
      return null
    }
  }

  private async hydrateMetadata() {
    if (!this.accountId || !hasApiAuthToken()) return

    const localMetadata = getAutomergeMetadata(this.accountId)
    if (Object.keys(localMetadata || {}).length > 0) return

    const response = await trpcClient.accounts.getMetadata.query({ account: this.accountId }).catch(() => null)
    if (response?.success && !!response.metadata && typeof response.metadata === 'object' && !Array.isArray(response.metadata)) {
      try {
        await this.mutateMetadata(response.metadata as AccountMetadata)
      } catch (error) {
        console.error('[sync.worker] metadata hydration skipped', error)
      }
    }
  }

  private subscribeToItems(itemIds: string[], repo: Repo) {
    // Subscribe to new items
    for (const id of itemIds) {
      if (this.subscribedHandles.has(id)) continue
      this.subscribedHandles.add(id)

      const url = toAutomergeUrlFromItemId(id)
      repo.find(url).then(handle => {
        const handleChange = () => {
          const item = normalizeItemSnapshot(id, handle.doc())
          this.callbacks?.onItemUpdated(id, item).catch(console.error)
        }
        handle.on('change', handleChange)

        // Trigger an immediate update for the item in case it changed while not subscribed
        handleChange()
      }).catch(console.error)
    }

    // Unsubscribe from removed items
    for (const subscribedId of this.subscribedHandles) {
      if (!itemIds.includes(subscribedId)) {
        this.subscribedHandles.delete(subscribedId)
        const url = toAutomergeUrlFromItemId(subscribedId)
        repo.find(url).then(handle => {
          handle.off('change')
        }).catch(console.error)
      }
    }
  }

  async mutateItem(mutationId: string, id: string, changes: Partial<Item>) {
    try {
      const updated = await withAutomergeDocumentChange(this.accountId!, id, doc => {
        for (const [key, value] of Object.entries(changes)) {
          if (value === undefined) delete doc[key]
          else doc[key] = value
        }
      })
      if (updated) {
        this.markDocumentDirty(id)
      }
    } catch (err: any) {
      if (this.callbacks) {
        this.callbacks.onMutationFailed(mutationId, err.message).catch(console.error)
        const trueState = getAutomergeItem(this.accountId!, id)
        this.callbacks.onItemUpdated(id, trueState).catch(console.error)
      }
    }
  }

  async createItem(item: Item) {
    try {
      const updated = await withAutomergeDocumentChange(this.accountId!, item.id, doc => {
        for (const [key, value] of Object.entries(item)) {
          doc[key] = value
        }
      }, { createIfMissing: true, initialValue: item })
      await addAutomergeItemIdsToIndex(this.accountId!, [item.id])
      if (updated) {
        this.markDocumentDirty(item.id)
      }
    } catch (err: any) {
      this.callbacks?.onMutationFailed('create', err.message).catch(console.error)
    }
  }

  async hardDeleteItems(itemIds: string[]) {
    try {
      await removeAutomergeItemIdsFromIndex(this.accountId!, itemIds)
      for (const id of itemIds) {
        await removeAutomergeItem(this.accountId!, id)
      }
    } catch (err: any) {
      this.callbacks?.onMutationFailed('hardDelete', err.message).catch(console.error)
    }
  }

  async storeItems(items: Item[]) {
    try {
      for (const item of items) {
        const updated = await withAutomergeDocumentChange(this.accountId!, item.id, doc => {
          for (const [key, value] of Object.entries(item)) {
            if (value === undefined) delete doc[key]
            else doc[key] = value
          }
        }, { createIfMissing: true, initialValue: item })
        if (updated) {
          this.markDocumentDirty(item.id)
        }
      }
    } catch (err: any) {
      this.callbacks?.onMutationFailed('store', err.message).catch(console.error)
      for (const item of items) {
        const trueState = getAutomergeItem(this.accountId!, item.id)
        this.callbacks?.onItemUpdated(item.id, trueState).catch(console.error)
      }
    }
  }

  async mutateMetadata(changes: Partial<AccountMetadata>) {
    try {
      const updated = await withAutomergeMetadataChange(this.accountId!, metadataDraft => {
        for (const [key, value] of Object.entries(changes)) {
          metadataDraft[key] = value
        }
      })
      if (updated) {
        this.markDocumentDirty(ACCOUNT_INDEX_DOCUMENT_ID)
      }
    } catch (err: any) {
      this.callbacks?.onMutationFailed('metadata', err.message).catch(console.error)
      this.callbacks?.onMetadataUpdated(getAutomergeMetadata(this.accountId!)).catch(console.error)
    }
  }

  async clearAutomergeDocStore() {
    await clearAutomergeDocStore(this.accountId!)
  }

  async exportAllBinaries() {
    return await exportAllBinaries(this.accountId!)
  }

  async restoreFromBinaries(documents: Partial<Record<string, string>>) {
    return await restoreFromBinaries(this.accountId!, documents)
  }

  async forceSync() {
    try {
      await this.adapter?.flush()
    } catch (err) {
      console.error('[sync.worker] forceSync failed', err)
    }
  }

  async pushSnapshots(): Promise<{ persisted: number; total: number }> {
    if (this.snapshotPushInFlight) {
      this.snapshotPushPending = true
      return { persisted: 0, total: 0 }
    }

    this.snapshotPushInFlight = true

    try {
      if (this.snapshotRequestCursor === null) {
        return { persisted: 0, total: 0 }
      }

      if (!this.accountId || !this.repo) {
        return { persisted: 0, total: 0 }
      }

      const authToken = await getActiveSessionToken()
      if (!authToken) {
        return { persisted: 0, total: 0 }
      }

      if (this.dirtyDocuments.has(ACCOUNT_INDEX_DOCUMENT_ID)) {
        this.dirtyDocuments.delete(ACCOUNT_INDEX_DOCUMENT_ID)
      }

      const dirtyItemIds = Array.from(this.dirtyDocuments)
      if (dirtyItemIds.length === 0) {
        this.snapshotRequestCursor = null
        return { persisted: 0, total: 0 }
      }

      const snapshotCursor = this.snapshotRequestCursor

      let persisted = 0
      let total = 0

      for (let start = 0; start < dirtyItemIds.length; start += 25) {
        const slice = dirtyItemIds.slice(start, start + 25)
        const snapshots: VaultSnapshotInput[] = []

        for (const itemId of slice) {
          const snapshot = await this.buildSnapshot(itemId, snapshotCursor)
          if (snapshot) {
            snapshots.push(snapshot)
          }
        }

        if (snapshots.length === 0) {
          continue
        }

        total += snapshots.length

        const response = await putSnapshotsWithToken({
          account: this.accountId,
          authToken,
          snapshots,
        })

        if (response?.success) {
          persisted += response.persisted
          for (const snapshot of snapshots) {
            this.dirtyDocuments.delete(snapshot.itemId)
          }
        }
      }

      if (persisted > 0) {
        this.snapshotRequestCursor = null
      }

      return { persisted, total }
    } finally {
      this.snapshotPushInFlight = false
      if (this.snapshotPushPending) {
        this.snapshotPushPending = false
        if (this.snapshotRequestCursor !== null) {
          this.scheduleSnapshotPush(this.snapshotRequestCursor)
        }
      }
    }
  }

  private async buildSnapshot(itemId: string, snapshotCursor: number): Promise<VaultSnapshotInput | null> {
    if (!this.repo || !this.accountId) {
      return null
    }

    const documentUrl = toAutomergeUrlFromItemId(itemId)
    const handle = await this.repo.find(documentUrl).catch(() => undefined)
    if (!handle) {
      return null
    }

    await handle.whenReady(['ready', 'unavailable'])
    if (!handle.isReady() || handle.isUnavailable()) {
      return null
    }

    const doc = handle.doc()
    if (!doc) {
      return null
    }

    const binary = Automerge.save(doc)
    if (!binary || binary.byteLength === 0) {
      return null
    }

    let encryptedDoc: CryptoResult
    try {
      encryptedDoc = await encryptBytesWithKey(getVaultKey(), binary)
    } catch (error) {
      console.error('[sync.worker] failed to encrypt snapshot binary', error)
      return null
    }

    const itemSnapshot = normalizeItemSnapshot(itemId, doc as Record<string, unknown>)
    if (!itemSnapshot) {
      return null
    }

    return {
      itemId,
      snapshot: encryptedDoc,
      snapshotCursor,
      type: normalizeSnapshotType(itemSnapshot.type, (itemSnapshot as any).originalType),
      modified: Date.now(),
      deleted: itemSnapshot.deleted === true || undefined,
    }
  }

  private async pushRecoveryItems() {
    if (this.callbacks) {
      try {
        const entries = await readManualRecoveryEntries()
        await this.callbacks.onRecoveryItemsChanged(entries)
      } catch (error) {
        console.error('[sync.worker] Failed to push recovery entries change', error)
      }
    }
  }

  async retryRecoveryItem(itemId: string) {
    await removeManualRecoveryEntryByItemId(itemId)
    await this.pushRecoveryItems()
  }

  async forceOverwriteRecoveryItem(itemId: string) {
    const localItem = getAutomergeItem(this.accountId!, itemId)
    if (!localItem) {
      throw new Error(`No local item found for ${itemId}. Force delete is available instead.`)
    }

    const localSnapshot = JSON.parse(JSON.stringify(localItem)) as Record<string, unknown>
    if (Array.isArray(localItem.prayedFor)) {
      localSnapshot.prayedFor = [...localItem.prayedFor]
    }

    await withAutomergeDocumentChange(
      this.accountId!,
      itemId,
      doc => {
        mutateDraftToMatchSnapshot(doc, localSnapshot)
        if (typeof doc.id !== 'string' || doc.id.length === 0) {
          doc.id = itemId
        }
      },
      {
        createIfMissing: true,
        initialValue: { id: itemId },
      },
    )

    await removeManualRecoveryEntryByItemId(itemId)
    await this.pushRecoveryItems()
  }

  async forceDeleteRecoveryItem(itemId: string) {
    const existing = getAutomergeItem(this.accountId!, itemId)

    await withAutomergeDocumentChange(
      this.accountId!,
      itemId,
      doc => {
        doc.id = itemId
        doc.type = existing?.type || 'person'
        doc.deleted = true
      },
      {
        createIfMissing: true,
        initialValue: {
          id: itemId,
        },
      },
    )

    await removeManualRecoveryEntryByItemId(itemId)
    await this.pushRecoveryItems()
  }

  async dismissRecoveryItem(entryId: string) {
    await removeManualRecoveryEntryById(entryId)
    await this.pushRecoveryItems()
  }

  async listRecoveryItems(): Promise<ManualRecoveryEntry[]> {
    return await readManualRecoveryEntries()
  }
}

Comlink.expose(new SyncWorker())

