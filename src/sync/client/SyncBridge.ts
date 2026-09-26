import * as Comlink from 'comlink'

import { useAppStore } from 'src/state/store'
import {
  hasVaultKey,
  lockVault,
  reloadKeyringFromStorage,
  syncKeyringFromServer,
  handleSessionExpired,
  getVaultSession,
} from 'src/api/vault'
import type { Item } from 'src/state/items'
import type { ManualRecoveryEntry } from 'src/sync/shared/manualRecoveryStore'
import type { BackupSyncState } from 'src/types/backup'
import type { ItemId } from 'src/shared/schemas/items'
import type { AccountMetadata } from 'src/state/metadata'
import type { SyncApi } from 'src/sync/worker/syncProtocol'
import { WorkerLifecycleManager } from './WorkerLifecycleManager'
import { SyncEventProcessor } from './SyncEventProcessor'
import { SyncDOMListeners } from './SyncDOMListeners'
import { attemptSessionRecovery } from 'src/api/vault/sessionRecovery'
import { resumePendingReencryption } from 'src/api/vault/reencrypt'
import { getOnlineState } from 'src/utils/onlineStatus'

export { clearAutomergeIndexedDb, clearAccountLocalData } from './localDataCleanup'

class SyncBridgeService {
  private eventProcessor: SyncEventProcessor
  private domListeners: SyncDOMListeners
  private lifecycleManager: WorkerLifecycleManager

  constructor() {
    this.eventProcessor = new SyncEventProcessor({
      onKeyVersionMissing: kver => {
        void this.handleKeyringUpdate(kver)
      },
      onActivity: () => {
        this.lifecycleManager.recordWorkerActivity()
      },
    })

    this.domListeners = new SyncDOMListeners()

    this.lifecycleManager = new WorkerLifecycleManager({
      onEvent: event => {
        this.eventProcessor.handleSyncEvent(event)
      },
      onStatusChange: status => {
        useAppStore.getState().setSyncStatus(status)
      },
      onSyncWarning: warning => {
        if (warning) {
          useAppStore.getState().setSyncWarning(warning)
        } else {
          useAppStore.getState().clearSyncWarning()
        }
      },
      onFatalError: error => {
        useAppStore.getState().setFatalError(error)
      },
      getAccountId: () => useAppStore.getState().account,
      onReady: () => {
        this.domListeners.start({
          setOnlineState: async isOnline => {
            const api = this.lifecycleManager.getSyncApi()
            if (api) await api.setOnlineState(isOnline)
          },
          onReconnect: async () => {
            await this.handleReconnect()
          },
          onVisibilityHidden: () => {
            const api = this.lifecycleManager.getSyncApi()
            if (api) void api.pushSnapshots()
          },
          onKeyringChange: () => {
            void this.handleKeyringUpdate()
          },
        })
      },
      onRestart: async (accountId: string) => {
        await this.initialize(accountId)
      },
      onShutdownCleanup: options => {
        if (!options?.internalRestart) {
          this.eventProcessor.reset(true)
          useAppStore.getState().reset()
          this.domListeners.stop()
        }
      },
    })
  }

  private reconnectSequence = 0

  private handleReconnect = async (): Promise<void> => {
    const currentSeq = ++this.reconnectSequence
    const account = this.lifecycleManager.getCurrentAccountId()
    if (!account) return

    let recovered = false
    try {
      recovered = await attemptSessionRecovery(account)
    } catch (err) {
      console.warn('[SyncBridge] Failed to attempt session recovery on reconnect:', err)
    }

    if (
      currentSeq !== this.reconnectSequence ||
      !getOnlineState() ||
      this.lifecycleManager.getCurrentAccountId() !== account
    ) {
      return
    }

    if (recovered) {
      useAppStore.getState().clearSyncWarning()
      const api = this.lifecycleManager.getSyncApi()
      if (api) {
        try {
          await api.flushSync()
        } catch (error) {
          console.error('[SyncBridge] flushSync failed on reconnect:', error)
        }
      }
    }

    try {
      await resumePendingReencryption(account)
    } catch (error) {
      console.warn('[SyncBridge] resumePendingReencryption failed on reconnect:', error)
    }
  }

  private handleKeyringUpdate = async (kver?: string) => {
    const currentAccountId = this.lifecycleManager.getCurrentAccountId()
    if (!currentAccountId) return
    let result = await reloadKeyringFromStorage()
    if (result.passwordChanged) {
      console.warn('[SyncBridge] Password changed in another tab/device. Locking vault.')
      await lockVault()
      return
    }
    if (kver && !hasVaultKey(kver)) {
      try {
        await syncKeyringFromServer(currentAccountId)
        result = await reloadKeyringFromStorage()
      } catch (err) {
        console.warn('[SyncBridge] Failed to sync keyring from server:', err)
      }
    }
    const syncApi = this.lifecycleManager.getSyncApi()
    if (result.success && result.keyringData && syncApi) {
      await syncApi.updateVaultKey(result.keyringData)
    }
  }

  requestClearOnShutdown(accountId?: string): void {
    this.lifecycleManager.requestClearOnShutdown(accountId)
  }

  isClearingLocalData(): boolean {
    return this.lifecycleManager.isClearingLocalData()
  }

  hasPendingClear(): boolean {
    return this.lifecycleManager.hasPendingClear()
  }

  async ensureReady(): Promise<void> {
    await this.lifecycleManager.ensureReady()
  }

  init(accountId: string, options?: { clearLocalData?: boolean }): Promise<void> {
    return this.lifecycleManager.init(accountId, options)
  }

  initialize(accountId: string, options?: { clearLocalData?: boolean }): Promise<void> {
    return this.lifecycleManager.initialize(accountId, options)
  }

  shutdown(options?: { clearLocalData?: boolean; internalRestart?: boolean; accountId?: string }): Promise<void> {
    return this.lifecycleManager.shutdown(options)
  }

  private async execute<T>(fn: (api: Comlink.Remote<SyncApi>) => Promise<T>): Promise<T> {
    const api = await this.lifecycleManager.ensureReady()
    return fn(api)
  }

  listRecoveryItems(): Promise<ManualRecoveryEntry[]> {
    return this.execute(async api => {
      const entries = await api.listRecoveryItems()
      this.eventProcessor.setRecoveryEntries(entries)
      return entries
    })
  }

  subscribeRecoveryItems(listener: (entries: ManualRecoveryEntry[]) => void): () => void {
    return this.eventProcessor.subscribeRecoveryItems(listener)
  }

  restoreFromBinaries(documents: Partial<Record<string, string>>): Promise<string[]> {
    return this.execute(async api => {
      const result = await api.restoreFromBinaries(documents)
      useAppStore.getState().incrementGeneration()
      return result
    })
  }

  initRepo(accountId: string, vaultKey: string): Promise<void> {
    return this.execute(api => {
      const refreshAuthToken = Comlink.proxy(async () => {
        await handleSessionExpired()
        return getVaultSession() || null
      })
      return api.initRepo(accountId, vaultKey, refreshAuthToken)
    })
  }

  setOnlineState(isOnline: boolean): Promise<void> {
    return this.execute(api => api.setOnlineState(isOnline))
  }

  bootstrapItems(): Promise<void> {
    return this.execute(api => api.bootstrapItems())
  }

  mutateItem(id: ItemId, changes: Partial<Item>): Promise<void> {
    return this.execute(api => api.mutateItem(id, changes))
  }

  createItem(item: Item): Promise<void> {
    return this.execute(api => api.createItem(item))
  }

  storeItems(items: Item[]): Promise<void> {
    return this.execute(api => api.storeItems(items))
  }

  mutateMetadata(changes: Partial<AccountMetadata>, options?: { pushRemote?: boolean }): Promise<void> {
    return this.execute(api => api.mutateMetadata(changes, options))
  }

  exportAllBinaries(): Promise<{ documents: Partial<Record<string, string>>; skipped: string[] }> {
    return this.execute(api => api.exportAllBinaries())
  }

  flushSync(): Promise<void> {
    return this.execute(api => api.flushSync())
  }

  fullResync(): Promise<boolean> {
    return this.execute(api => api.fullResync())
  }

  pushSnapshots(): Promise<{ persisted: number; total: number }> {
    return this.execute(api => api.pushSnapshots())
  }

  retrySave(): Promise<{ success: boolean; error?: string }> {
    return this.execute(api => api.retrySave())
  }

  retryRecoveryItem(itemId: ItemId): Promise<void> {
    return this.execute(api => api.retryRecoveryItem(itemId))
  }

  forceOverwriteRecoveryItem(itemId: ItemId): Promise<void> {
    return this.execute(api => api.forceOverwriteRecoveryItem(itemId))
  }

  forceDeleteRecoveryItem(itemId: ItemId): Promise<void> {
    return this.execute(api => api.forceDeleteRecoveryItem(itemId))
  }

  compactItem(itemId: ItemId): Promise<void> {
    return this.execute(api => api.compactItem(itemId))
  }

  dismissRecoveryItem(entryId: string): Promise<void> {
    return this.execute(api => api.dismissRecoveryItem(entryId))
  }

  updateVaultKey(vaultKey: string): Promise<void> {
    return this.execute(api => api.updateVaultKey(vaultKey))
  }

  reencryptAllItems(onProgress: (done: number, total: number) => void): Promise<{
    succeeded: ItemId[]
    failed: Array<{ itemId: ItemId; error: string }>
  }> {
    return this.execute(api => {
      const refreshAuthToken = Comlink.proxy(async () => {
        await handleSessionExpired()
        return getVaultSession() || null
      })
      return api.reencryptAllItems(Comlink.proxy(onProgress), refreshAuthToken)
    })
  }

  exportSyncState(): Promise<BackupSyncState> {
    return this.execute(api => api.exportSyncState())
  }

  restoreSyncState(state: Partial<BackupSyncState>): Promise<void> {
    return this.execute(api => api.restoreSyncState(state))
  }

  claimLeader(): Promise<void> {
    return this.execute(api => api.claimLeader())
  }
}

export const SyncBridge = new SyncBridgeService()
