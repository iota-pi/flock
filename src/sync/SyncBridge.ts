/* eslint-disable @typescript-eslint/no-explicit-any */
import * as Comlink from 'comlink'
import type { SyncApi, SyncCallbacks } from 'src/workers/syncProtocol'
import { useDataStore } from 'src/state/dataStore'
import { useUiStore } from 'src/state/uiStore'
import { useSyncStore } from 'src/state/syncStore'
import { getStoredVaultKey } from 'src/api/vault/util'
import type { Item } from 'src/state/items'
import type { ManualRecoveryEntry } from 'src/sync/manualRecoveryStore'
import { setOnRecoveryItemsChangedListener } from 'src/api/syncHealthCoordinator'

let syncApi: Comlink.Remote<SyncApi> | null = null
const ITEM_UPDATE_BATCH_MAX = 50
let onlineListenerAttached = false

const pendingItemUpdates = new Map<string, Item | null>()
let itemUpdateFlushHandle: number | null = null

let recoveryEntries: ManualRecoveryEntry[] = []
const recoveryEntriesListeners = new Set<(entries: ManualRecoveryEntry[]) => void>()

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

const syncCallbacks: SyncCallbacks = {
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
  onStartRequest: async () => {
    useUiStore.getState().startRequest()
  },
  onFinishRequest: async () => {
    useUiStore.getState().finishRequest()
  },
  onAuthFailure: async message => {
    const syncStore = useSyncStore.getState()
    syncStore.setSyncStatus('offline')
    syncStore.setSyncWarning(message)
  },
  onRecoveryItemsChanged: async entries => {
    recoveryEntries = entries
    for (const listener of recoveryEntriesListeners) {
      listener(entries)
    }
  },
}

export const SyncBridge = {
  initialize: async (accountId: string) => {
    if (syncApi) return

    useSyncStore.getState().setSyncStatus('connecting')
    const initialOnlineState = navigator.onLine

    const worker = new Worker(new URL('../workers/sync.worker.ts', import.meta.url), { type: 'module' })
    syncApi = Comlink.wrap<SyncApi>(worker)

    try {
      void syncApi.setOnlineState(initialOnlineState)

      const vaultKey = getStoredVaultKey()
      if (!vaultKey) throw new Error('Vault key not found in storage')

      await syncApi.initRepo(
        accountId,
        vaultKey,
        Comlink.proxy(syncCallbacks),
      )
      await syncApi.bootstrapLegacyItems()

      if (!onlineListenerAttached) {
        onlineListenerAttached = true

        const setWorkerOnlineState = (isOnline: boolean) => {
          if (!syncApi) return
          void syncApi.setOnlineState(isOnline)
        }

        window.addEventListener(
          'online',
          () => setWorkerOnlineState(true),
        )
        window.addEventListener(
          'offline',
          () => setWorkerOnlineState(false),
        )
      }

      setOnRecoveryItemsChangedListener(() => {
        void SyncBridge.listRecoveryItems()
      })
    } catch (error) {
      console.error('Failed to initialize SyncBridge:', error)
      useSyncStore.getState().setSyncStatus('offline')
      worker.terminate()
      syncApi = null
    }
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

  retryRecoveryItem: async (itemId: string) => {
    if (!syncApi) throw new Error('SyncBridge not initialized')
    await syncApi.retryRecoveryItem(itemId)
  },

  forceOverwriteRecoveryItem: async (itemId: string) => {
    if (!syncApi) throw new Error('SyncBridge not initialized')
    await syncApi.forceOverwriteRecoveryItem(itemId)
  },

  forceDeleteRecoveryItem: async (itemId: string) => {
    if (!syncApi) throw new Error('SyncBridge not initialized')
    await syncApi.forceDeleteRecoveryItem(itemId)
  },

  dismissRecoveryItem: async (entryId: string) => {
    if (!syncApi) throw new Error('SyncBridge not initialized')
    await syncApi.dismissRecoveryItem(entryId)
  },

  listRecoveryItems: async (): Promise<ManualRecoveryEntry[]> => {
    if (!syncApi) throw new Error('SyncBridge not initialized')
    const entries = await syncApi.listRecoveryItems()
    recoveryEntries = entries
    for (const listener of recoveryEntriesListeners) {
      listener(entries)
    }
    return entries
  },

  subscribeRecoveryItems: (listener: (entries: ManualRecoveryEntry[]) => void) => {
    recoveryEntriesListeners.add(listener)
    listener(recoveryEntries)
    return () => {
      recoveryEntriesListeners.delete(listener)
    }
  },

  updateVaultKey: async (vaultKey: string) => {
    if (!syncApi) throw new Error('SyncBridge not initialized')
    await syncApi.updateVaultKey(vaultKey)
  },

  reencryptAllItems: async (onProgress: (done: number, total: number) => void) => {
    if (!syncApi) throw new Error('SyncBridge not initialized')
    await syncApi.reencryptAllItems(Comlink.proxy(onProgress))
  },
}

