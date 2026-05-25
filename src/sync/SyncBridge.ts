/* eslint-disable @typescript-eslint/no-explicit-any */
import * as Comlink from 'comlink'
import type { SyncApi, SyncCallbacks } from '../workers/syncProtocol'
import { useDataStore } from '../state/dataStore'
import { useSyncStore } from '../state/syncStore'
import { getStoredVaultKey } from '../api/vault'
import type { Item } from 'src/state/items'

let syncApi: Comlink.Remote<SyncApi> | null = null
const ITEM_UPDATE_BATCH_MAX = 50

const pendingItemUpdates = new Map<string, Item | null>()
let itemUpdateFlushHandle: number | null = null

const flushItemUpdates = () => {
  if (pendingItemUpdates.size === 0) return

  const updates = Array.from(pendingItemUpdates.entries()).map(([id, item]) => ({ id, item }))
  pendingItemUpdates.clear()
  itemUpdateFlushHandle = null

  useDataStore.getState().updateItemsFromServer(updates)
}

const scheduleItemUpdateFlush = () => {
  if (itemUpdateFlushHandle !== null) return
  itemUpdateFlushHandle = requestAnimationFrame(flushItemUpdates)
}

export const SyncBridge = {
  initialize: async (accountId: string) => {
    if (syncApi) return

    useSyncStore.getState().setSyncStatus('connecting')
    const worker = new Worker(new URL('../workers/sync.worker.ts', import.meta.url), { type: 'module' })
    syncApi = Comlink.wrap<SyncApi>(worker)

    const callbacks: SyncCallbacks = {
      onReady: async () => {},
      onStatusChange: async status => {
        useSyncStore.getState().setSyncStatus(status)
      },
      onItemUpdated: async (id, item) => {
        pendingItemUpdates.set(id, item)

        if (pendingItemUpdates.size >= ITEM_UPDATE_BATCH_MAX) {
          if (itemUpdateFlushHandle !== null) {
            cancelAnimationFrame(itemUpdateFlushHandle)
            itemUpdateFlushHandle = null
          }
          flushItemUpdates()
          return
        }

        scheduleItemUpdateFlush()
      },
      onIndexUpdated: async itemIds => {
        useDataStore.getState().updateIndexFromServer(itemIds)
      },
      onMetadataUpdated: async metadata => {
        useDataStore.getState().updateMetadataFromServer(metadata)
      },
      onMutationFailed: async (mutationId, error) => {
        // Implement toast notification/Sentry logging here if needed
        console.error(`Mutation ${mutationId} failed: ${error}`)
      },
    }

    const vaultKey = getStoredVaultKey()
    if (!vaultKey) throw new Error('Vault key not found in storage')

    await syncApi.initRepo(accountId, vaultKey, Comlink.proxy(callbacks))
    await syncApi.bootstrapLegacyItems()
  },

  forceSync: async () => {
    if (!syncApi) throw new Error('SyncBridge not initialized')
    await syncApi.forceSync()
  },

  mutateItem: async (mutationId: string, id: string, changes: Partial<Item>) => {
    if (!syncApi) throw new Error('SyncBridge not initialized')
    await syncApi.mutateItem(mutationId, id, changes)
  },

  createItem: async (item: any) => {
    if (!syncApi) throw new Error('SyncBridge not initialized')
    await syncApi.createItem(item)
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
