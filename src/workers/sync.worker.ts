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
  getAutomergeItems,
  listAutomergeItemIds,
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
} from '../sync/automergeDocStore'
import { initWorkerVault } from '../api/vault'
import { getAutomergeRepo, setVaultNetworkAccount } from '../sync/automergeRepo'
import { toAutomergeUrlFromItemId } from '../sync/automergeRepoIds'
import type { Repo } from '@automerge/automerge-repo/slim'

class SyncWorker implements SyncApi {
  private callbacks: Comlink.Remote<SyncCallbacks> | null = null
  private accountId: string | null = null
  private subscribedHandles = new Set<string>()

  async initRepo(accountId: string, vaultKey: string, callbacks: Comlink.Remote<SyncCallbacks>) {
    this.accountId = accountId
    this.callbacks = callbacks

    await initWorkerVault(vaultKey)

    await Automerge.initializeWasm(wasmUrl)

    setVaultNetworkAccount(accountId)
    await initializeAutomergeDocStore(accountId)

    const repo = getAutomergeRepo(accountId)

    const itemsList = getAutomergeItems()
    const items: Record<string, Item> = {}
    itemsList.forEach(i => items[i.id] = i)
    const itemIds = listAutomergeItemIds()
    const metadata = getAutomergeMetadata()

    await callbacks.onReady({ items, itemIds, metadata })

    const indexUrl = toAutomergeUrlFromItemId(ACCOUNT_INDEX_DOCUMENT_ID)
    const indexHandle = await repo.find(indexUrl)
    indexHandle.on('change', () => {
      const newItemIds = listAutomergeItemIds()
      if (this.callbacks) {
        this.callbacks.onIndexUpdated(newItemIds).catch(console.error)
        
        const newMetadata = getAutomergeMetadata()
        this.callbacks.onMetadataUpdated(newMetadata).catch(console.error)
      }

      this.subscribeToItems(newItemIds, repo)
    })

    this.subscribeToItems(itemIds, repo)
  }

  private subscribeToItems(itemIds: string[], repo: Repo) {
    for (const id of itemIds) {
      if (this.subscribedHandles.has(id)) continue
      this.subscribedHandles.add(id)

      const url = toAutomergeUrlFromItemId(id)
      repo.find(url).then((handle: any) => {
        handle.on('change', () => {
          const item = getAutomergeItem(id)
          if (this.callbacks) {
            this.callbacks.onItemUpdated(id, item).catch(console.error)
          }
        })
      }).catch(console.error)
    }
  }

  async mutateItem(mutationId: string, id: string, changes: Partial<Item>) {
    try {
      await withAutomergeDocumentChange(id, (doc: any) => {
        for (const [key, value] of Object.entries(changes)) {
          if (value === undefined) delete doc[key]
          else doc[key] = value
        }
      })
    } catch (err: any) {
      if (this.callbacks) {
        this.callbacks.onMutationFailed(mutationId, err.message).catch(console.error)
        const trueState = getAutomergeItem(id)
        this.callbacks.onItemUpdated(id, trueState).catch(console.error)
      }
    }
  }

  async createItem(item: Item) {
    try {
      await withAutomergeDocumentChange(item.id, (doc: any) => {
        for (const [key, value] of Object.entries(item)) {
          doc[key] = value
        }
      }, { createIfMissing: true, initialValue: item as any })
      await addAutomergeItemIdsToIndex([item.id])
    } catch (err: any) {
      this.callbacks?.onMutationFailed('create', err.message).catch(console.error)
    }
  }

  async deleteItem(id: string) {
    try {
      await removeAutomergeItemIdsFromIndex([id])
      await removeAutomergeItem(id)
    } catch (err: any) {
      this.callbacks?.onMutationFailed('delete', err.message).catch(console.error)
    }
  }

  async hardDeleteItems(itemIds: string[]) {
    try {
      await removeAutomergeItemIdsFromIndex(itemIds)
      for (const id of itemIds) {
        await removeAutomergeItem(id)
      }
    } catch (err: any) {
      this.callbacks?.onMutationFailed('hardDelete', err.message).catch(console.error)
    }
  }

  async storeItems(items: Item[]) {
    try {
      for (const item of items) {
        await withAutomergeDocumentChange(item.id, (doc: any) => {
          for (const [key, value] of Object.entries(item)) {
            if (value === undefined) delete doc[key]
            else doc[key] = value
          }
        }, { createIfMissing: true, initialValue: item as any })
      }
    } catch (err: any) {
      this.callbacks?.onMutationFailed('store', err.message).catch(console.error)
      for (const item of items) {
        const trueState = getAutomergeItem(item.id)
        this.callbacks?.onItemUpdated(item.id, trueState).catch(console.error)
      }
    }
  }

  async mutateMetadata(changes: Partial<AccountMetadata>) {
    try {
      await withAutomergeMetadataChange((metadataDraft: any) => {
        for (const [key, value] of Object.entries(changes)) {
          metadataDraft[key] = value
        }
      })
    } catch (err: any) {
      this.callbacks?.onMutationFailed('metadata', err.message).catch(console.error)
      this.callbacks?.onMetadataUpdated(getAutomergeMetadata()).catch(console.error)
    }
  }

  async clearAutomergeDocStore() {
    await clearAutomergeDocStore()
  }

  async exportAllBinaries() {
    return await exportAllBinaries()
  }

  async restoreFromBinaries(documents: Partial<Record<string, string>>) {
    return await restoreFromBinaries(documents)
  }
}

Comlink.expose(new SyncWorker())
