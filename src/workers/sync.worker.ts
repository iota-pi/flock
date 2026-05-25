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
import { decryptObject, getVaultKey, initWorkerVault } from '../api/vault'
import { hasApiAuthToken } from '../api/runtime'
import { trpcClient } from '../api/trpcClient'
import { decodeEncryptedAutomergeDoc } from '../shared/automergeBranchCipher'
import {
  getAutomergeRepo,
  getVaultNetworkAdapter,
  setVaultNetworkAccount,
} from '../sync/automergeRepo'
import { toAutomergeUrlFromItemId } from '../sync/automergeRepoIds'
import type { Repo } from '@automerge/automerge-repo/slim'

class SyncWorker implements SyncApi {
  private accountId: string | null = null
  private callbacks: SyncCallbacks | null = null
  private subscribedHandles = new Set<string>()

  async initRepo(accountId: string, vaultKey: string, callbacks: SyncCallbacks) {
    this.accountId = accountId
    this.callbacks = callbacks

    await initWorkerVault(vaultKey)

    // Load Automerge WASM module
    await Automerge.initializeWasm(wasmUrl)

    // Initialise Automerge repo
    setVaultNetworkAccount(accountId)
    await initializeAutomergeDocStore(accountId)

    const repo = getAutomergeRepo(accountId)
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
      console.error('[sync.worker] failed to fetch legacy items', e)
      return { items: [] as any[] }
    })

    const fetchedItems = response.items.filter((entry: any) => entry && typeof entry === 'object' && typeof entry.item === 'string' && entry.item.length > 0)

    if (fetchedItems.length === 0) return

    const legacySnapshots: Item[] = []

    const promises = fetchedItems.map(async (item: any) => {
      try {
        if (item.metadata?.deleted === true) {
          legacySnapshots.push({ id: item.item, deleted: true } as unknown as Item)
          return
        }

        if (Array.isArray(item.branches) && item.branches.length > 0) {
          for (const branch of item.branches) {
            if (!branch?.encryptedAutomergeDoc) continue
            const binary = await this.decryptBranchBinary(branch.encryptedAutomergeDoc)
            if (binary) {
              await hydrateAutomergeDocumentBinary(this.accountId!, item.item, binary)
              return
            }
          }
        }

        if (typeof item.cipher === 'string' && item.cipher.length > 0 && typeof item.metadata?.iv === 'string' && item.metadata.iv.length > 0) {
          const decrypted = await decryptObject({ iv: item.metadata.iv, cipher: item.cipher }).catch(() => null)
          if (decrypted && typeof decrypted === 'object' && !Array.isArray(decrypted)) {
            const snapshot = { ...(decrypted as Record<string, unknown>) }
            if (!snapshot.id || typeof snapshot.id !== 'string') {
              snapshot.id = item.item
            }
            legacySnapshots.push(snapshot as Item)
          }
        }
      } catch (error) {
        console.error('[sync.worker] failed to hydrate fetched item envelope', { itemId: item.item, error })
      }
    })

    await Promise.allSettled(promises)

    if (legacySnapshots.length > 0) {
      await this.storeItems(legacySnapshots)
    }

    await this.hydrateMetadata()
  }

  private async decryptBranchBinary(encryptedAutomergeDoc: string): Promise<Uint8Array | null> {
    try {
      const decoded = decodeEncryptedAutomergeDoc(encryptedAutomergeDoc)
      const iv = new Uint8Array(decoded.iv.byteLength)
      iv.set(decoded.iv)
      const cipher = new Uint8Array(decoded.cipher.byteLength)
      cipher.set(decoded.cipher)
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, getVaultKey(), cipher)
      return new Uint8Array(plaintext)
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
      await withAutomergeDocumentChange(this.accountId!, id, doc => {
        for (const [key, value] of Object.entries(changes)) {
          if (value === undefined) delete doc[key]
          else doc[key] = value
        }
      })
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
      await withAutomergeDocumentChange(this.accountId!, item.id, doc => {
        for (const [key, value] of Object.entries(item)) {
          doc[key] = value
        }
      }, { createIfMissing: true, initialValue: item })
      await addAutomergeItemIdsToIndex(this.accountId!, [item.id])
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
        await withAutomergeDocumentChange(this.accountId!, item.id, doc => {
          for (const [key, value] of Object.entries(item)) {
            if (value === undefined) delete doc[key]
            else doc[key] = value
          }
        }, { createIfMissing: true, initialValue: item })
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
      await withAutomergeMetadataChange(this.accountId!, metadataDraft => {
        for (const [key, value] of Object.entries(changes)) {
          metadataDraft[key] = value
        }
      })
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
    const adapter = getVaultNetworkAdapter(this.accountId!)
    try {
      await adapter.flush()
    } catch (err) {
      console.error('[sync.worker] forceSync failed', err)
    }
  }
}

Comlink.expose(new SyncWorker())
