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
let _globalEventChannel: MessageChannel | null = null

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
      console.error(`Mutation ${event.mutationType} failed: ${event.error}`)
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

let initializationPromise: Promise<void> | null = null

export const SyncBridge = {
  ensureReady: async () => {
    if (initializationPromise) {
      await initializationPromise
    }
    if (!syncApi) {
      throw new Error('SyncBridge not initialized')
    }
  },

  initialize: (accountId: string): Promise<void> => {
    if (syncApi && currentAccountId === accountId) return Promise.resolve()
    if (initializationPromise && currentAccountId === accountId) {
      return initializationPromise
    }

    initializationPromise = (async () => {
      if (syncApi || workerInstance) {
        await SyncBridge.shutdown()
      }

      currentAccountId = accountId
      useAppStore.getState().setSyncStatus('connecting')
      const initialOnlineState = getOnlineState()

      let worker: Worker | null = null
      try {
        const vaultKey = await exportKeyringData()
        if (!vaultKey) throw new Error('Vault key not found in storage')

        if (currentAccountId !== accountId) {
          console.warn('[SyncBridge] Initialization aborted due to account change or concurrent shutdown')
          return
        }

        worker = new Worker(new URL('../worker/sync.worker.ts', import.meta.url), { type: 'module' })
        worker.onerror = (event: ErrorEvent) => {
          const error = event.error || new Error(event.message || 'Sync Worker Error')
          console.error('[SyncBridge] Worker error:', error)
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new ErrorEvent('error', { error, message: event.message || error.message }))
          }
        }

        workerInstance = worker
        const wrappedApi = Comlink.wrap<SyncApi>(worker)

        _globalEventChannel = new MessageChannel()
        _globalEventChannel.port1.onmessage = ev => {
          handleSyncEvent(ev.data as ClientEvent)
        }
        _globalEventChannel.port1.start()
        worker.postMessage({ type: 'EVENT_PORT', port: _globalEventChannel.port2 }, [_globalEventChannel.port2])

        await wrappedApi.initRepo(
          accountId,
          vaultKey,
        )
        await wrappedApi.setOnlineState(initialOnlineState)
        await wrappedApi.bootstrapItems()

        syncApi = wrappedApi

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
              initializationPromise = null
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
        if (worker) {
          worker.terminate()
        }
        if (workerInstance === worker) {
          workerInstance = null
        }
        syncApi = null
        currentAccountId = null
        initializationPromise = null
      }
    })()

    return initializationPromise
  },

  forceSync: async () => {
    await SyncBridge.ensureReady()
    await syncApi!.forceSync()
  },

  mutateItem: async (id: ItemId, changes: Partial<Item>) => {
    await SyncBridge.ensureReady()
    await syncApi!.mutateItem(id, changes)
  },

  createItem: async (item: any) => {
    await SyncBridge.ensureReady()
    await syncApi!.createItem(item)
  },

  hardDeleteItems: async (itemIds: ItemId[]) => {
    await SyncBridge.ensureReady()
    await syncApi!.hardDeleteItems(itemIds)
  },

  storeItems: async (items: any[]) => {
    await SyncBridge.ensureReady()
    await syncApi!.storeItems(items)
  },

  mutateMetadata: async (changes: any) => {
    await SyncBridge.ensureReady()
    await syncApi!.mutateMetadata(changes)
  },

  exportAllBinaries: async () => {
    await SyncBridge.ensureReady()
    return await syncApi!.exportAllBinaries()
  },

  restoreFromBinaries: async (documents: Partial<Record<string, string>>) => {
    await SyncBridge.ensureReady()
    const result = await syncApi!.restoreFromBinaries(documents)
    useAppStore.getState().incrementGeneration()
    return result
  },

  retryRecoveryItem: async (itemId: ItemId) => {
    await SyncBridge.ensureReady()
    await syncApi!.retryRecoveryItem(itemId)
  },

  forceOverwriteRecoveryItem: async (itemId: ItemId) => {
    await SyncBridge.ensureReady()
    await syncApi!.forceOverwriteRecoveryItem(itemId)
  },

  forceDeleteRecoveryItem: async (itemId: ItemId) => {
    await SyncBridge.ensureReady()
    await syncApi!.forceDeleteRecoveryItem(itemId)
  },

  dismissRecoveryItem: async (entryId: string) => {
    await SyncBridge.ensureReady()
    await syncApi!.dismissRecoveryItem(entryId)
  },

  listRecoveryItems: async (): Promise<ManualRecoveryEntry[]> => {
    await SyncBridge.ensureReady()
    const entries = await syncApi!.listRecoveryItems()
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
    await SyncBridge.ensureReady()
    await syncApi!.updateVaultKey(vaultKey)
  },

  reencryptAllItems: async (onProgress: (done: number, total: number) => void) => {
    await SyncBridge.ensureReady()
    await syncApi!.reencryptAllItems(Comlink.proxy(onProgress))
  },

  exportSyncState: async () => {
    await SyncBridge.ensureReady()
    return await syncApi!.exportSyncState()
  },

  restoreSyncState: async (state: Partial<BackupSyncState>) => {
    await SyncBridge.ensureReady()
    await syncApi!.restoreSyncState(state)
  },

  shutdown: async (options?: { clearLocalData?: boolean }) => {
    initializationPromise = null
    currentAccountId = null
    stopWorkerHeartbeat()
    resetCrashMetrics()
    resetSyncHealthState()

    const oldWorker = workerInstance
    const oldSyncApi = syncApi
    workerInstance = null
    syncApi = null

    if (itemUpdateFlushHandle !== null) {
      cancelAnimationFrame(itemUpdateFlushHandle)
      itemUpdateFlushHandle = null
    }
    pendingItemUpdates.clear()
    useAppStore.getState().reset()

    if (oldSyncApi) {
      try {
        await Promise.race([
          oldSyncApi.shutdown(options),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error('Sync worker shutdown timed out')), 1000)
          ),
        ])
      } catch (err) {
        console.error('[SyncBridge] Failed to shut down worker cleanly:', err)
      }
    }

    if (oldWorker) {
      oldWorker.terminate()
    }
    if (!initializationPromise) {
      useAppStore.getState().setSyncStatus('offline')
    }

    recoveryEntries = []
    for (const listener of recoveryEntriesListeners) {
      listener([])
    }
  },
}

