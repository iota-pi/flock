import * as Comlink from 'comlink'

import type { SyncApi } from 'src/sync/worker/syncProtocol'
import type { ClientEvent } from '../worker/SyncEventHub'
import { useAppStore } from 'src/state/store'
import { exportKeyringData } from 'src/api/vault'
import type { Item } from 'src/state/items'
import type { ManualRecoveryEntry } from 'src/sync/shared/manualRecoveryStore'
import type { BackupSyncState } from 'src/types/backup'
import type { ItemId } from 'src/shared/schemas/items'
import type { AccountMetadata } from 'src/state/metadata'
import { setupWorkerHealthCheck, stopWorkerHeartbeat, resetCrashMetrics } from './syncWorkerHealth'
import { getOnlineState } from 'src/utils/onlineStatus'


class SyncBridgeService {
  private syncApi: Comlink.Remote<SyncApi> | null = null
  private workerInstance: Worker | null = null
  private currentAccountId: string | null = null
  private readonly ITEM_UPDATE_BATCH_MAX = 50
  private onlineListenerAttached = false

  private pendingItemUpdates = new Map<string, Item | null>()
  private itemUpdateFlushHandle: ReturnType<typeof setTimeout> | null = null
  private globalEventChannel: MessageChannel | null = null
  private pingChannel: MessageChannel | null = null

  private recoveryEntries: ManualRecoveryEntry[] = []
  private recoveryEntriesListeners = new Set<(entries: ManualRecoveryEntry[]) => void>()

  private initializationPromise: Promise<void> | null = null
  private currentInitSession = 0
  private initRetryCount = 0
  private static readonly MAX_INIT_RETRIES = 5
  private static readonly INIT_RETRY_DELAYS = [2000, 5000, 10000, 30000, 60000]
  private _restartResolve: (() => void) | null = null

  private flushItemUpdates = () => {
    if (this.pendingItemUpdates.size === 0) return

    const updates = Array.from(this.pendingItemUpdates.entries()).map(([id, item]) => ({ id, item }))
    this.pendingItemUpdates.clear()
    this.itemUpdateFlushHandle = null

    useAppStore.getState().updateItemsFromServer(updates)
  }

  private scheduleItemUpdateFlush = () => {
    if (this.itemUpdateFlushHandle !== null) return
    this.itemUpdateFlushHandle = setTimeout(this.flushItemUpdates, 0)
  }

  private handleSyncEvent = (event: ClientEvent) => {
    switch (event.type) {
      case 'ready':
        break
      case 'statusChange':
        useAppStore.getState().setSyncStatus(event.status)
        break
      case 'itemUpdated': {
        const { id, item } = event
        this.pendingItemUpdates.set(id, item)

        if (this.pendingItemUpdates.size >= this.ITEM_UPDATE_BATCH_MAX) {
          if (this.itemUpdateFlushHandle !== null) {
            clearTimeout(this.itemUpdateFlushHandle)
            this.itemUpdateFlushHandle = null
          }
          this.flushItemUpdates()
          return
        }

        this.scheduleItemUpdateFlush()
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
        this.recoveryEntries = event.entries
        for (const listener of this.recoveryEntriesListeners) {
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

  async ensureReady() {
    if (this.initializationPromise) {
      await this.initializationPromise
    }
    if (!this.syncApi) {
      throw new Error('SyncBridge not initialized')
    }
  }

  initialize(accountId: string): Promise<void> {
    if (this.syncApi && this.currentAccountId === accountId) return Promise.resolve()
    if (this.initializationPromise && this.currentAccountId === accountId) {
      return this.initializationPromise
    }

    this.currentAccountId = accountId
    this.currentInitSession += 1
    const initSession = this.currentInitSession

    this.initializationPromise = (async () => {
      if (this.syncApi || this.workerInstance) {
        await this.shutdown({ internalRestart: true })
      }

      useAppStore.getState().setSyncStatus('connecting')
      const initialOnlineState = getOnlineState()

      let worker: Worker | null = null
      try {
        const vaultKey = await exportKeyringData()
        if (!vaultKey) throw new Error('Vault key not found in storage')

        if (initSession !== this.currentInitSession || this.currentAccountId !== accountId) {
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

        this.workerInstance = worker
        const wrappedApi = Comlink.wrap<SyncApi>(worker)

        const globalEventChannel = new MessageChannel()
        this.globalEventChannel = globalEventChannel
        globalEventChannel.port1.onmessage = ev => {
          this.handleSyncEvent(ev.data as ClientEvent)
        }
        globalEventChannel.port1.start()
        worker.postMessage({ type: 'EVENT_PORT', port: globalEventChannel.port2 }, [globalEventChannel.port2])

        const pingChannel = new MessageChannel()
        this.pingChannel = pingChannel
        pingChannel.port1.start()
        worker.postMessage({ type: 'INIT_PING_PORT', port: pingChannel.port2 }, [pingChannel.port2])

        await wrappedApi.initRepo(
          accountId,
          vaultKey,
        )
        await wrappedApi.setOnlineState(initialOnlineState)
        await wrappedApi.bootstrapItems()

        if (initSession !== this.currentInitSession || this.currentAccountId !== accountId) {
          console.warn('[SyncBridge] Initialization aborted due to account change or concurrent shutdown')
          worker.terminate()
          if (this.workerInstance === worker) {
            this.workerInstance = null
          }
          return
        }

        this.syncApi = wrappedApi

        if (!this.onlineListenerAttached) {
          this.onlineListenerAttached = true

          const handleOnlineStateChange = () => {
            if (!this.syncApi) return
            void this.syncApi.setOnlineState(getOnlineState())
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

        this.initRetryCount = 0
        useAppStore.getState().clearSyncWarning()
        setupWorkerHealthCheck({
          worker,
          pingPort: pingChannel.port1,
          isCurrentWorker: () => this.workerInstance === worker && !!this.syncApi,
          onCrash: (willRestart = true) => {
            if (this.workerInstance === worker) {
              if (this.globalEventChannel) {
                this.globalEventChannel.port1.close()
                this.globalEventChannel = null
              }
              if (this.pingChannel) {
                this.pingChannel.port1.close()
                this.pingChannel = null
              }
              this.workerInstance = null
              this.syncApi = null
              if (willRestart) {
                // Keep initializationPromise as a pending promise so mutations queue up
                this.initializationPromise = new Promise(resolve => {
                  this._restartResolve = resolve
                })
              } else {
                this.initializationPromise = null
                this._restartResolve?.()
                this._restartResolve = null
              }
            }
          },
          onRestart: () => {
            setTimeout(() => {
              if (this.currentAccountId === accountId) {
                this.initializationPromise = null
                this.initialize(accountId)
                  .then(() => {
                    this._restartResolve?.()
                    this._restartResolve = null
                  })
                  .catch(err => {
                    console.error('[SyncBridge] Auto-restart initialization failed:', err)
                    this._restartResolve?.()
                    this._restartResolve = null
                  })
              } else {
                this._restartResolve?.()
                this._restartResolve = null
              }
            }, 1000)
          },
        })
      } catch (error) {
        console.error('Failed to initialize SyncBridge:', error)
        if (worker) {
          worker.terminate()
        }
        if (this.globalEventChannel) {
          this.globalEventChannel.port1.close()
          this.globalEventChannel = null
        }
        if (this.pingChannel) {
          this.pingChannel.port1.close()
          this.pingChannel = null
        }
        if (this.workerInstance === worker) {
          this.workerInstance = null
        }
        if (this.syncApi) {
          this.syncApi = null
        }

        if (initSession === this.currentInitSession && this.initRetryCount < SyncBridgeService.MAX_INIT_RETRIES) {
          const delay = SyncBridgeService.INIT_RETRY_DELAYS[
            Math.min(this.initRetryCount, SyncBridgeService.INIT_RETRY_DELAYS.length - 1)
          ]
          this.initRetryCount += 1
          useAppStore.getState().setSyncWarning(`Sync initialization failed. Retrying in ${delay / 1000}s...`)

          // Keep initializationPromise alive so ensureReady() callers wait
          const retryPromise = new Promise<void>((resolve, reject) => {
            setTimeout(() => {
              if (this.currentInitSession !== initSession) return reject(new Error('Aborted'))
              this.initializationPromise = null
              this.initialize(accountId).then(resolve).catch(reject)
            }, delay)
          })
          retryPromise.catch(() => {})
          this.initializationPromise = retryPromise
        } else {
          // Exhausted retries — surface to user
          if (initSession === this.currentInitSession) {
            useAppStore.getState().setFatalError('Unable to start sync. Please refresh the page.')
            useAppStore.getState().setSyncStatus('offline')
            this.currentAccountId = null
            this.initializationPromise = null
          }
        }
        throw error
      }
    })()

    return this.initializationPromise
  }

  async listRecoveryItems(): Promise<ManualRecoveryEntry[]> {
    await this.ensureReady()
    const entries = await this.syncApi!.listRecoveryItems()
    this.recoveryEntries = entries
    for (const listener of this.recoveryEntriesListeners) {
      listener(entries)
    }
    return entries
  }

  subscribeRecoveryItems(listener: (entries: ManualRecoveryEntry[]) => void) {
    this.recoveryEntriesListeners.add(listener)
    listener(this.recoveryEntries)
    return () => {
      this.recoveryEntriesListeners.delete(listener)
    }
  }

  async restoreFromBinaries(documents: Partial<Record<string, string>>) {
    await this.ensureReady()
    const result = await this.syncApi!.restoreFromBinaries(documents)
    useAppStore.getState().incrementGeneration()
    return result
  }

  async reencryptAllItems(onProgress: (done: number, total: number) => void) {
    await this.ensureReady()
    await this.syncApi!.reencryptAllItems(Comlink.proxy(onProgress))
  }

  async shutdown(options?: { clearLocalData?: boolean; internalRestart?: boolean }) {
    if (!options?.internalRestart) {
      this.currentInitSession += 1
      this.initializationPromise = null
      this.currentAccountId = null
    }
    this.initRetryCount = 0
    if (this._restartResolve) {
      this._restartResolve()
      this._restartResolve = null
    }
    stopWorkerHeartbeat()
    resetCrashMetrics()

    const oldWorker = this.workerInstance
    const oldSyncApi = this.syncApi
    const oldGlobalEventChannel = this.globalEventChannel
    const oldPingChannel = this.pingChannel
    this.workerInstance = null
    this.syncApi = null
    this.globalEventChannel = null
    this.pingChannel = null

    if (!options?.internalRestart) {
      if (this.itemUpdateFlushHandle !== null) {
        clearTimeout(this.itemUpdateFlushHandle)
        this.itemUpdateFlushHandle = null
      }
      this.pendingItemUpdates.clear()
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
    if (!this.initializationPromise) {
      useAppStore.getState().setSyncStatus('offline')
    }

    if (!options?.internalRestart) {
      this.recoveryEntries = []
      for (const listener of this.recoveryEntriesListeners) {
        listener([])
      }
      this.recoveryEntriesListeners.clear()
    }
  }

  async initRepo(accountId: string, vaultKey: string): Promise<void> {
    await this.ensureReady()
    return this.syncApi!.initRepo(accountId, vaultKey)
  }

  async setOnlineState(isOnline: boolean): Promise<void> {
    await this.ensureReady()
    return this.syncApi!.setOnlineState(isOnline)
  }

  async bootstrapItems(): Promise<void> {
    await this.ensureReady()
    return this.syncApi!.bootstrapItems()
  }

  async mutateItem(id: ItemId, changes: Partial<Item>): Promise<void> {
    await this.ensureReady()
    return this.syncApi!.mutateItem(id, changes)
  }

  async createItem(item: Item): Promise<void> {
    await this.ensureReady()
    return this.syncApi!.createItem(item)
  }

  async storeItems(items: Item[]): Promise<void> {
    await this.ensureReady()
    return this.syncApi!.storeItems(items)
  }

  async mutateMetadata(changes: Partial<AccountMetadata>): Promise<void> {
    await this.ensureReady()
    return this.syncApi!.mutateMetadata(changes)
  }

  async exportAllBinaries(): Promise<{ documents: Partial<Record<string, string>>; skipped: string[] }> {
    await this.ensureReady()
    return this.syncApi!.exportAllBinaries()
  }

  async flushSync(): Promise<void> {
    await this.ensureReady()
    return this.syncApi!.flushSync()
  }

  async fullResync(): Promise<void> {
    await this.ensureReady()
    return this.syncApi!.fullResync()
  }

  async pushSnapshots(): Promise<{ persisted: number; total: number }> {
    await this.ensureReady()
    return this.syncApi!.pushSnapshots()
  }

  async retryRecoveryItem(itemId: ItemId): Promise<void> {
    await this.ensureReady()
    return this.syncApi!.retryRecoveryItem(itemId)
  }

  async forceOverwriteRecoveryItem(itemId: ItemId): Promise<void> {
    await this.ensureReady()
    return this.syncApi!.forceOverwriteRecoveryItem(itemId)
  }

  async forceDeleteRecoveryItem(itemId: ItemId): Promise<void> {
    await this.ensureReady()
    return this.syncApi!.forceDeleteRecoveryItem(itemId)
  }

  async dismissRecoveryItem(entryId: string): Promise<void> {
    await this.ensureReady()
    return this.syncApi!.dismissRecoveryItem(entryId)
  }

  async updateVaultKey(vaultKey: string): Promise<void> {
    await this.ensureReady()
    return this.syncApi!.updateVaultKey(vaultKey)
  }

  async reencryptAllItems(onProgress: (done: number, total: number) => void): Promise<{
    succeeded: ItemId[]
    failed: Array<{ itemId: ItemId; error: string }>
  }> {
    await this.ensureReady()
    return this.syncApi!.reencryptAllItems(Comlink.proxy(onProgress))
  }

  async exportSyncState(): Promise<BackupSyncState> {
    await this.ensureReady()
    return this.syncApi!.exportSyncState()
  }

  async restoreSyncState(state: Partial<BackupSyncState>): Promise<void> {
    await this.ensureReady()
    return this.syncApi!.restoreSyncState(state)
  }
}

export const SyncBridge = new SyncBridgeService()
