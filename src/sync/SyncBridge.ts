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
import type { BackupSyncState } from 'src/types/backup'
import { setupWorkerHealthCheck, stopWorkerHeartbeat, resetCrashMetrics } from './syncWorkerHealth'

let syncApi: Comlink.Remote<SyncApi> | null = null
let workerInstance: Worker | null = null
let currentAccountId: string | null = null
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
  onQuotaExceeded: async message => {
    const syncStore = useSyncStore.getState()
    syncStore.setSyncStatus('degraded')
    syncStore.setSyncWarning(message)
  },
}

export const SyncBridge = {
  initialize: async (accountId: string) => {
    if (syncApi && currentAccountId === accountId) return

    if (syncApi || workerInstance) {
      await SyncBridge.shutdown()
    }

    currentAccountId = accountId
    useSyncStore.getState().setSyncStatus('connecting')
    const initialOnlineState = navigator.onLine

    const worker = new Worker(new URL('../workers/sync.worker.ts', import.meta.url), { type: 'module' })
    workerInstance = worker
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

      useSyncStore.getState().clearSyncWarning()
      setupWorkerHealthCheck({
        worker,
        accountId,
        pingFn: async () => {
          if (syncApi) await syncApi.ping()
        },
        isCurrentWorker: () => workerInstance === worker && !!syncApi,
        onCrash: () => {
          if (workerInstance === worker) {
            workerInstance = null
            syncApi = null
          }
        },
        onRestart: () => {
          setTimeout(() => {
            if (currentAccountId === accountId) {
              SyncBridge.initialize(accountId).catch(err => {
                console.error('[SyncBridge] Auto-restart initialization failed:', err)
              })
            }
          }, 1000)
        },
      })
    } catch (error) {
      console.error('Failed to initialize SyncBridge:', error)
      useSyncStore.getState().setSyncStatus('offline')
      worker.terminate()
      if (workerInstance === worker) {
        workerInstance = null
      }
      syncApi = null
      currentAccountId = null
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

  exportSyncState: async () => {
    if (!syncApi) throw new Error('SyncBridge not initialized')
    return await syncApi.exportSyncState()
  },

  restoreSyncState: async (state: Partial<BackupSyncState>) => {
    if (!syncApi) throw new Error('SyncBridge not initialized')
    await syncApi.restoreSyncState(state)
  },

  shutdown: async () => {
    currentAccountId = null
    stopWorkerHeartbeat()
    resetCrashMetrics()

    if (itemUpdateFlushHandle !== null) {
      cancelAnimationFrame(itemUpdateFlushHandle)
      itemUpdateFlushHandle = null
    }
    pendingItemUpdates.clear()

    if (syncApi) {
      try {
        await Promise.race([
          syncApi.shutdown(),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error('Sync worker shutdown timed out')), 1000)
          ),
        ])
      } catch (err) {
        console.error('[SyncBridge] Failed to shut down worker cleanly:', err)
      }
    }

    if (workerInstance) {
      workerInstance.terminate()
      workerInstance = null
    }
    syncApi = null
    useSyncStore.getState().setSyncStatus('offline')

    recoveryEntries = []
    for (const listener of recoveryEntriesListeners) {
      listener([])
    }
  },
}

