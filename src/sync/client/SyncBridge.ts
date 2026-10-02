import type * as Comlink from 'comlink'
import * as Sentry from '@sentry/react'

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
import type { ManualRecoveryEntry } from '../shared/manualRecoveryStore'
import type { BackupSyncState } from 'src/types/backup'
import type { ItemId } from 'src/shared/schemas/items'
import type { AccountMetadata } from 'src/state/metadata'
import type { SyncApi } from '../worker/syncProtocol'
import { WorkerLifecycleManager } from './WorkerLifecycleManager'
import { SyncEventProcessor } from './SyncEventProcessor'
import { SyncDOMListeners } from './SyncDOMListeners'
import { attemptSessionRecovery } from 'src/api/vault/sessionRecovery'
import { resumePendingReencryption } from 'src/api/vault/reencrypt'
import { getOnlineState } from 'src/utils/onlineStatus'
import { SingleFlightGuard } from '../utils/SingleFlightGuard'

class SyncBridgeService {
  private eventProcessor: SyncEventProcessor
  private domListeners: SyncDOMListeners
  private lifecycleManager: WorkerLifecycleManager
  private keyringUpdateGuard = new SingleFlightGuard<void>()
  private pendingMissingKeyVersions = new Set<string>()

  constructor() {
    this.eventProcessor = new SyncEventProcessor({
      onKeyVersionMissing: kver => {
        void this.handleKeyringUpdate(kver)
      },
      onTokenRefreshNeeded: () => {
        void this.handleTokenRefresh()
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
        Sentry.setTag('syncStatus', status)
        Sentry.addBreadcrumb({
          category: 'sync',
          message: `Sync status changed to ${status}`,
          level: status === 'offline' ? 'warning' : 'info',
        })
      },
      onSyncWarning: warning => {
        if (warning) {
          useAppStore.getState().setSyncWarning(warning)
          Sentry.addBreadcrumb({
            category: 'sync',
            message: `Sync warning: ${warning}`,
            level: 'warning',
          })
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
            Sentry.setTag('online', isOnline)
            Sentry.addBreadcrumb({
              category: 'network',
              message: isOnline ? 'Network online' : 'Network offline',
              level: isOnline ? 'info' : 'warning',
            })
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
          Sentry.setUser(null)
          this.eventProcessor.reset(true)
          useAppStore.getState().reset()
          this.domListeners.stop()
          this.keyringUpdateGuard.clear()
          this.pendingMissingKeyVersions.clear()
        }
      },
    })
  }

  private reconnectSequence = 0

  private handleReconnect = async (): Promise<void> => {
    this.reconnectSequence += 1
    const currentSeq = this.reconnectSequence
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
    if (kver) {
      this.pendingMissingKeyVersions.add(kver)
    }

    do {
      await this.keyringUpdateGuard.run(async () => {
        const currentAccountId = this.lifecycleManager.getCurrentAccountId()
        if (!currentAccountId) {
          this.pendingMissingKeyVersions.clear()
          return
        }
        let result = await reloadKeyringFromStorage()
        if (result.passwordChanged) {
          console.warn('[SyncBridge] Password changed in another tab/device. Locking vault.')
          this.pendingMissingKeyVersions.clear()
          await lockVault()
          return
        }
        const keysToCheck = Array.from(this.pendingMissingKeyVersions)
        const hasMissingKey = keysToCheck.some(k => !hasVaultKey(k))
        if (hasMissingKey) {
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
        for (const k of keysToCheck) {
          this.pendingMissingKeyVersions.delete(k)
        }
        for (const k of this.pendingMissingKeyVersions) {
          if (hasVaultKey(k)) {
            this.pendingMissingKeyVersions.delete(k)
          }
        }
      })
    } while (kver && this.pendingMissingKeyVersions.has(kver))
  }

  private handleTokenRefresh = async () => {
    try {
      await handleSessionExpired()
      const token = getVaultSession() || null
      const syncApi = this.lifecycleManager.getSyncApi()
      if (syncApi) {
        await syncApi.updateAuthToken(token)
      }
    } catch (err) {
      console.error('[SyncBridge] Failed to handle token refresh:', err)
      const syncApi = this.lifecycleManager.getSyncApi()
      if (syncApi) {
        try {
          await syncApi.updateAuthToken(null)
        } catch {
          // Ignore
        }
      }
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
    Sentry.setUser({ id: accountId })
    Sentry.setTag('accountId', accountId)
    return this.lifecycleManager.initialize(accountId, options)
  }

  async shutdown(options?: { clearLocalData?: boolean; internalRestart?: boolean; accountId?: string }): Promise<void> {
    await this.keyringUpdateGuard.waitForRunning()
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
    return this.execute(api => api.initRepo(accountId, vaultKey))
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

  recreateOversizedItem(itemId: ItemId): Promise<ItemId> {
    return this.execute(api => api.recreateOversizedItem(itemId))
  }

  /**
   * @deprecated Use recreateOversizedItem instead.
   */
  compactItem(itemId: ItemId): Promise<ItemId | void> {
    return this.execute(api => api.recreateOversizedItem(itemId))
  }

  dismissRecoveryItem(entryId: string): Promise<void> {
    return this.execute(api => api.dismissRecoveryItem(entryId))
  }

  updateVaultKey(vaultKey: string): Promise<void> {
    return this.execute(api => api.updateVaultKey(vaultKey))
  }

  updateAuthToken(token: string | null): Promise<void> {
    return this.execute(api => api.updateAuthToken(token))
  }

  reencryptAllItems(onProgress?: (done: number, total: number) => void): Promise<{
    succeeded: ItemId[]
    failed: Array<{ itemId: ItemId; error: string }>
  }> {
    return this.execute(async api => {
      const unsubscribe = onProgress
        ? this.eventProcessor.subscribeReencryptProgress(onProgress)
        : undefined
      try {
        return await api.reencryptAllItems()
      } finally {
        unsubscribe?.()
      }
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
