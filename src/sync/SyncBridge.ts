/* eslint-disable @typescript-eslint/no-explicit-any */
import * as Comlink from 'comlink'
import type { SyncApi, SyncCallbacks } from '../workers/syncProtocol'
import { useDataStore } from '../state/dataStore'
import { getStoredVaultKey } from '../api/vault'

let syncApi: Comlink.Remote<SyncApi> | null = null

export const SyncBridge = {
  initialize: async (accountId: string) => {
    if (syncApi) return

    const worker = new Worker(new URL('../workers/sync.worker.ts', import.meta.url), { type: 'module' })
    syncApi = Comlink.wrap<SyncApi>(worker)

    const callbacks: SyncCallbacks = {
      onReady: state => {
        useDataStore.getState().setFullState(state)
      },
      onItemUpdated: (id, item) => {
        useDataStore.getState().updateItemFromServer(id, item)
      },
      onIndexUpdated: itemIds => {
        useDataStore.getState().updateIndexFromServer(itemIds)
      },
      onMetadataUpdated: metadata => {
        useDataStore.getState().updateMetadataFromServer(metadata)
      },
      onMutationFailed: (mutationId, error) => {
        // Implement toast notification here if needed
        console.error(`Mutation ${mutationId} failed: ${error}`)
      },
    }

    const vaultKey = getStoredVaultKey()
    if (!vaultKey) throw new Error('Vault key not found in storage')

    await syncApi.initRepo(accountId, vaultKey, Comlink.proxy(callbacks) as any)
  },

  mutateItem: async (mutationId: string, id: string, changes: any) => {
    if (!syncApi) throw new Error('SyncBridge not initialized')
    await syncApi.mutateItem(mutationId, id, changes)
  },

  createItem: async (item: any) => {
    if (!syncApi) throw new Error('SyncBridge not initialized')
    await syncApi.createItem(item)
  },

  deleteItem: async (id: string) => {
    if (!syncApi) throw new Error('SyncBridge not initialized')
    await syncApi.deleteItem(id)
  },

  hardDeleteItems: async (itemIds: string[]) => {
    if (!syncApi) throw new Error('SyncBridge not initialized')
    await syncApi.hardDeleteItems(itemIds)
  },

  storeItems: async (items: any[]) => {
    if (!syncApi) throw new Error('SyncBridge not initialized')
    await syncApi.storeItems(items)
  },

  mutateMetadata: async (changes: any) => {
    if (!syncApi) throw new Error('SyncBridge not initialized')
    await syncApi.mutateMetadata(changes)
  },

  clearAutomergeDocStore: async () => {
    if (!syncApi) throw new Error('SyncBridge not initialized')
    await syncApi.clearAutomergeDocStore()
  },

  exportAllBinaries: async () => {
    if (!syncApi) throw new Error('SyncBridge not initialized')
    return await syncApi.exportAllBinaries()
  },

  restoreFromBinaries: async (documents: Partial<Record<string, string>>) => {
    if (!syncApi) throw new Error('SyncBridge not initialized')
    return await syncApi.restoreFromBinaries(documents)
  },
}
