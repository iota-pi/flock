/* eslint-disable @typescript-eslint/no-explicit-any */
import * as Comlink from 'comlink'

import type { SyncApi } from 'src/sync/worker/syncProtocol'
import type { ClientEvent } from '../worker/SyncEventHub'
import { useAppStore } from 'src/state/store'
import { exportKeyringData } from 'src/api/vault'
import type { Item } from 'src/state/items'
import type { ManualRecoveryEntry } from 'src/sync/shared/manualRecoveryStore'
import { setOnRecoveryItemsChangedListener, resetSyncHealthState } from 'src/api/syncHealthCoordinator'
import type { BackupSyncState } from 'src/types/backup'
import { setupWorkerHealthCheck, stopWorkerHeartbeat, resetCrashMetrics } from './syncWorkerHealth'
import { getOnlineState } from 'src/utils/onlineStatus'
import { ItemId } from 'src/shared/schemas/items'


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

  useAppStore.getState().updateItemsFromServer(updates)
}

const scheduleItemUpdateFlush = () => {
  if (itemUpdateFlushHandle !== null) return
  itemUpdateFlushHandle = requestAnimationFrame(flushItemUpdates)
}

const handleSyncEvent = (event: ClientEvent) => {
  switch (event.type) {
    case 'ready':
      break
    case 'statusChange':
      useAppStore.getState().setSyncStatus(event.status)
      break
    case 'itemUpdated': {
      const { id, item } = event
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
      break
    }
    case 'indexUpdated':
      useAppStore.getState().updateIndexFromServer(event.itemIds)
      break
    case 'metadataUpdated':
      useAppStore.getState().updateMetadataFromServer(event.metadata)
      break
    case 'mutationFailed':
      console.error(`Mutation ${event.mutationId} failed: ${event.error}`)
      break
    case 'startRequest':
      useAppStore.getState().startRequest()
      break
    case 'finishRequest':
      useAppStore.getState().finishRequest()
      break
    case 'authFailure': {
      const syncStore = useAppStore.getState()
      syncStore.setSyncStatus('offline')
      syncStore.setSyncWarning(event.message)
      break
    }
    case 'recoveryItemsChanged':
      recoveryEntries = event.entries
      for (const listener of recoveryEntriesListeners) {
        listener(event.entries)
      }
      break
    case 'quotaExceeded': {
      const syncStore = useAppStore.getState()
      syncStore.setSyncStatus('degraded')
      syncStore.setSyncWarning(event.message)
      break
    }
  }
}

export const SyncBridge = {
  initialize: async (accountId: string) => {
    if (syncApi && currentAccountId === accountId) return

    if (syncApi || workerInstance) {
      await SyncBridge.shutdown()
    }

    currentAccountId = accountId
    useAppStore.getState().setSyncStatus('connecting')
    const initialOnlineState = getOnlineState()

    const worker = new Worker(new URL('../worker/sync.worker.ts', import.meta.url), { type: 'module' })
    workerInstance = worker
    syncApi = Comlink.wrap<SyncApi>(worker)

    try {
      void syncApi.setOnlineState(initialOnlineState)

      const vaultKey = await exportKeyringData()
      if (!vaultKey) throw new Error('Vault key not found in storage')

      await syncApi.initRepo(
        accountId,
        vaultKey,
        Comlink.proxy(handleSyncEvent),
      )
      await syncApi.bootstrapLegacyItems()

      if (!onlineListenerAttached) {
        onlineListenerAttached = true

        const handleOnlineStateChange = () => {
          if (!syncApi) return
          void syncApi.setOnlineState(getOnlineState())
        }

        window.addEventListener(
          'online',
          handleOnlineStateChange,
        )
        window.addEventListener(
          'offline',
          handleOnlineStateChange,
        )
        if (typeof document !== 'undefined') {
          document.addEventListener(
            'visibilitychange',
            handleOnlineStateChange,
          )
        }
      }

      setOnRecoveryItemsChangedListener(() => {
        void SyncBridge.listRecoveryItems()
      })

      useAppStore.getState().clearSyncWarning()
      setupWorkerHealthCheck({
        worker,
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
      useAppStore.getState().setSyncStatus('offline')
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

  mutateItem: async (mutationId: string, id: ItemId, changes: Partial<Item>) => {
    if (!syncApi) throw new Error('SyncBridge not initialized')
    await syncApi.mutateItem(mutationId, id, changes)
  },

  createItem: async (item: any) => {
    if (!syncApi) throw new Error('SyncBridge not initialized')
    await syncApi.createItem(item)
  },

  hardDeleteItems: async (itemIds: ItemId[]) => {
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
    const result = await syncApi.restoreFromBinaries(documents)
    useAppStore.getState().incrementGeneration()
    return result
  },

  retryRecoveryItem: async (itemId: ItemId) => {
    if (!syncApi) throw new Error('SyncBridge not initialized')
    await syncApi.retryRecoveryItem(itemId)
  },

  forceOverwriteRecoveryItem: async (itemId: ItemId) => {
    if (!syncApi) throw new Error('SyncBridge not initialized')
    await syncApi.forceOverwriteRecoveryItem(itemId)
  },

  forceDeleteRecoveryItem: async (itemId: ItemId) => {
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
    resetSyncHealthState()

    if (itemUpdateFlushHandle !== null) {
      cancelAnimationFrame(itemUpdateFlushHandle)
      itemUpdateFlushHandle = null
    }
    pendingItemUpdates.clear()
    useAppStore.getState().reset()

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
    useAppStore.getState().setSyncStatus('offline')

    recoveryEntries = []
    for (const listener of recoveryEntriesListeners) {
      listener([])
    }
  },
}

