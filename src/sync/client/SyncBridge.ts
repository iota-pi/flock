import * as Comlink from 'comlink'

import type { SyncApi } from 'src/sync/worker/syncProtocol'
import type { ClientEvent } from '../worker/SyncEventHub'
import { useAppStore } from 'src/state/store'
import { exportKeyringData } from 'src/api/vault'
import type { Item } from 'src/state/items'
import type { ManualRecoveryEntry } from 'src/sync/shared/manualRecoveryStore'
import { setupWorkerHealthCheck, stopWorkerHeartbeat, resetCrashMetrics } from './syncWorkerHealth'
import { getOnlineState } from 'src/utils/onlineStatus'


let syncApi: Comlink.Remote<SyncApi> | null = null
let workerInstance: Worker | null = null
let currentAccountId: string | null = null
const ITEM_UPDATE_BATCH_MAX = 50
let onlineListenerAttached = false

const pendingItemUpdates = new Map<string, Item | null>()
let itemUpdateFlushHandle: ReturnType<typeof setTimeout> | null = null
let _globalEventChannel: MessageChannel | null = null
let _pingChannel: MessageChannel | null = null

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
  itemUpdateFlushHandle = setTimeout(flushItemUpdates, 0)
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
          clearTimeout(itemUpdateFlushHandle)
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
      useAppStore.getState().updateMetadata(event.metadata)
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
let currentInitSession = 0

const baseBridge = {
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

    currentAccountId = accountId
    currentInitSession += 1
    const initSession = currentInitSession

    initializationPromise = (async () => {
      if (syncApi || workerInstance) {
        await baseBridge.shutdown({ internalRestart: true })
      }

      useAppStore.getState().setSyncStatus('connecting')
      const initialOnlineState = getOnlineState()

      let worker: Worker | null = null
      try {
        const vaultKey = await exportKeyringData()
        if (!vaultKey) throw new Error('Vault key not found in storage')

        if (initSession !== currentInitSession || currentAccountId !== accountId) {
          console.warn('[SyncBridge] Initialization aborted due to account change or concurrent shutdown')
          return
        }

        worker = new Worker(new URL('../worker/sync.worker.ts', import.meta.url), { type: 'module' })
        worker.addEventListener('error', (event: ErrorEvent) => {
          const error = event.error || new Error(event.message || 'Sync Worker Error')
          console.error('[SyncBridge] Worker error:', error)
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new ErrorEvent('error', { error, message: event.message || error.message }))
          }
        })

        workerInstance = worker
        const wrappedApi = Comlink.wrap<SyncApi>(worker)

        const globalEventChannel = new MessageChannel()
        _globalEventChannel = globalEventChannel
        globalEventChannel.port1.onmessage = ev => {
          handleSyncEvent(ev.data as ClientEvent)
        }
        globalEventChannel.port1.start()
        worker.postMessage({ type: 'EVENT_PORT', port: globalEventChannel.port2 }, [globalEventChannel.port2])

        const pingChannel = new MessageChannel()
        _pingChannel = pingChannel
        pingChannel.port1.start()
        worker.postMessage({ type: 'INIT_PING_PORT', port: pingChannel.port2 }, [pingChannel.port2])

        await wrappedApi.initRepo(
          accountId,
          vaultKey,
        )
        await wrappedApi.setOnlineState(initialOnlineState)
        await wrappedApi.bootstrapItems()

        if (initSession !== currentInitSession || currentAccountId !== accountId) {
          console.warn('[SyncBridge] Initialization aborted due to account change or concurrent shutdown')
          worker.terminate()
          if (workerInstance === worker) {
            workerInstance = null
          }
          return
        }

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
        }

        useAppStore.getState().clearSyncWarning()
        setupWorkerHealthCheck({
          worker,
          pingPort: pingChannel.port1,
          isCurrentWorker: () => workerInstance === worker && !!syncApi,
          onCrash: () => {
            if (workerInstance === worker) {
              if (_globalEventChannel) {
                _globalEventChannel.port1.close()
                _globalEventChannel = null
              }
              if (_pingChannel) {
                _pingChannel.port1.close()
                _pingChannel = null
              }
              workerInstance = null
              syncApi = null
              initializationPromise = null
            }
          },
          onRestart: () => {
            setTimeout(() => {
              if (currentAccountId === accountId) {
                baseBridge.initialize(accountId).catch(err => {
                  console.error('[SyncBridge] Auto-restart initialization failed:', err)
                })
              }
            }, 1000)
          },
        })
      } catch (error) {
        console.error('Failed to initialize SyncBridge:', error)
        if (worker) {
          worker.terminate()
        }
        if (_globalEventChannel) {
          _globalEventChannel.port1.close()
          _globalEventChannel = null
        }
        if (_pingChannel) {
          _pingChannel.port1.close()
          _pingChannel = null
        }
        if (workerInstance === worker) {
          workerInstance = null
        }
        if (initSession === currentInitSession) {
          useAppStore.getState().setSyncStatus('offline')
          syncApi = null
          currentAccountId = null
          initializationPromise = null
        }
        throw error
      }
    })()

    return initializationPromise
  },

  listRecoveryItems: async (): Promise<ManualRecoveryEntry[]> => {
    await baseBridge.ensureReady()
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

  restoreFromBinaries: async (documents: Partial<Record<string, string>>) => {
    await baseBridge.ensureReady()
    const result = await syncApi!.restoreFromBinaries(documents)
    useAppStore.getState().incrementGeneration()
    return result
  },

  reencryptAllItems: async (onProgress: (done: number, total: number) => void) => {
    await baseBridge.ensureReady()
    await syncApi!.reencryptAllItems(Comlink.proxy(onProgress))
  },

  shutdown: async (options?: { clearLocalData?: boolean; internalRestart?: boolean }) => {
    if (!options?.internalRestart) {
      currentInitSession += 1
      initializationPromise = null
      currentAccountId = null
    }
    stopWorkerHeartbeat()
    resetCrashMetrics()

    const oldWorker = workerInstance
    const oldSyncApi = syncApi
    const oldGlobalEventChannel = _globalEventChannel
    const oldPingChannel = _pingChannel
    workerInstance = null
    syncApi = null
    _globalEventChannel = null
    _pingChannel = null

    if (!options?.internalRestart) {
      if (itemUpdateFlushHandle !== null) {
        clearTimeout(itemUpdateFlushHandle)
        itemUpdateFlushHandle = null
      }
      pendingItemUpdates.clear()
      useAppStore.getState().reset()
    }

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
    if (oldGlobalEventChannel) {
      oldGlobalEventChannel.port1.close()
    }
    if (oldPingChannel) {
      oldPingChannel.port1.close()
    }
    if (!initializationPromise) {
      useAppStore.getState().setSyncStatus('offline')
    }

    if (!options?.internalRestart) {
      recoveryEntries = []
      for (const listener of recoveryEntriesListeners) {
        listener([])
      }
      recoveryEntriesListeners.clear()
    }
  },
}

type Promisified<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : T[K]
}

export type SyncBridgeType = typeof baseBridge & Promisified<SyncApi>

export const SyncBridge: SyncBridgeType = new Proxy(baseBridge as unknown as SyncBridgeType, {
  get(target, prop, receiver) {
    if (prop === 'then') {
      return undefined
    }

    if (prop in target) {
      return Reflect.get(target, prop, receiver)
    }

    if (typeof prop === 'string') {
      return async (...args: unknown[]) => {
        await target.ensureReady()
        const method = syncApi
          ? (syncApi as unknown as Record<string, (...methodArgs: unknown[]) => unknown>)[prop]
          : undefined
        if (typeof method !== 'function') {
          throw new TypeError(`SyncBridge: method '${prop}' does not exist on syncApi`)
        }
        return await method.apply(syncApi, args)
      }
    }

    return Reflect.get(target, prop, receiver)
  },
})

