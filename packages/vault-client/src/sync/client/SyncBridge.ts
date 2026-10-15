import type * as Comlink from 'comlink'

import {
  hasVaultKey,
  reloadKeyringFromStorage,
  syncKeyringFromServer,
  handleSessionExpired,
  getVaultSession,
} from '../../api/vault'
import type { ManualRecoveryEntry, ReadManualRecoveryOptions } from '../shared/manualRecoveryStore'
import type { BackupSyncState } from '../shared/backupSyncState'
import type { ItemId } from '@vault/shared'
import type { VaultDoc, VaultMetadata } from '../shared/types'
import type { SyncApi } from '../worker/syncProtocol'
import { WorkerLifecycleManager } from './WorkerLifecycleManager'
import { SyncEventProcessor } from './SyncEventProcessor'
import { SyncDOMListeners } from './SyncDOMListeners'
import { attemptSessionRecovery } from '../../api/sessionRecovery'
import { resumePendingReencryption } from '../../api/reencrypt'
import { getOnlineState } from '../utils/onlineStatus'
import { SingleFlightGuard } from '../utils/SingleFlightGuard'
import { noopTelemetry, type SyncStateSink, type SyncTelemetry } from './host'

export interface SyncBridgeOptions<TDoc extends VaultDoc, TMeta extends VaultMetadata> {
  /** Creates the app's sync worker (whose entry file calls exposeSyncWorker) */
  createWorker: () => Worker
  sink: SyncStateSink<TDoc, TMeta>
  getAccountId: () => string | null
  telemetry?: SyncTelemetry
  /** Locks the vault, for example after the password was changed on another device */
  lockVault: () => Promise<void>
}

/**
 * Main-thread facade over the sync worker. Apps create one instance with createSyncBridge.
 */
export class SyncBridgeService<TDoc extends VaultDoc = VaultDoc, TMeta extends VaultMetadata = VaultMetadata> {
  private readonly sink: SyncStateSink<TDoc, TMeta>
  private readonly telemetry: SyncTelemetry
  private eventProcessor: SyncEventProcessor<TDoc, TMeta>
  private domListeners: SyncDOMListeners
  private lifecycleManager: WorkerLifecycleManager
  private keyringUpdateGuard = new SingleFlightGuard<void>()
  private pendingMissingKeyVersions = new Set<string>()

  constructor(private readonly options: SyncBridgeOptions<TDoc, TMeta>) {
    this.sink = options.sink
    this.telemetry = options.telemetry ?? noopTelemetry
    this.eventProcessor = new SyncEventProcessor<TDoc, TMeta>(this.sink, {
      onKeyVersionMissing: kver => {
        void this.handleKeyringUpdate(kver)
      },
      onTokenRefreshNeeded: () => {
        void this.handleTokenRefresh()
      },
      onActivity: () => {
        this.lifecycleManager.recordWorkerActivity()
      },
    }, this.telemetry)

    this.domListeners = new SyncDOMListeners()

    this.lifecycleManager = new WorkerLifecycleManager({
      createWorker: options.createWorker,
      telemetry: this.telemetry,
      onEvent: event => {
        this.eventProcessor.handleSyncEvent(event)
      },
      onStatusChange: status => {
        this.sink.setSyncStatus(status)
        this.telemetry.setTag('syncStatus', status)
        this.telemetry.addBreadcrumb({
          category: 'sync',
          message: `Sync status changed to ${status}`,
          level: status === 'offline' ? 'warning' : 'info',
        })
      },
      onSyncWarning: warning => {
        if (warning) {
          this.sink.setSyncWarning(warning)
          this.telemetry.addBreadcrumb({
            category: 'sync',
            message: `Sync warning: ${warning}`,
            level: 'warning',
          })
        } else {
          this.sink.clearSyncWarning()
        }
      },
      onFatalError: error => {
        this.sink.setFatalError(error)
      },
      getAccountId: options.getAccountId,
      onReady: () => {
        this.domListeners.start({
          setOnlineState: async isOnline => {
            this.telemetry.setTag('online', isOnline)
            this.telemetry.addBreadcrumb({
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
      onShutdownCleanup: shutdownOptions => {
        if (!shutdownOptions?.internalRestart) {
          this.telemetry.setUser(null)
          this.eventProcessor.reset(true)
          this.sink.reset()
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
      this.sink.clearSyncWarning()
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
      await resumePendingReencryption(this, account)
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
          await this.options.lockVault()
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
    this.telemetry.setUser(accountId)
    this.telemetry.setTag('accountId', accountId)
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

  listRecoveryItems(options?: ReadManualRecoveryOptions): Promise<ManualRecoveryEntry[]> {
    return this.execute(async api => {
      const entries = await api.listRecoveryItems(options)
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
      this.sink.onDataRestored?.()
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

  mutateItem(id: ItemId, changes: Partial<TDoc>): Promise<void> {
    return this.execute(api => api.mutateItem(id, changes))
  }

  createItem(item: TDoc): Promise<void> {
    return this.execute(api => api.createItem(item))
  }

  storeItems(items: TDoc[]): Promise<void> {
    return this.execute(api => api.storeItems(items))
  }

  mutateMetadata(changes: Partial<TMeta>): Promise<void> {
    return this.execute(api => api.mutateMetadata(changes))
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

export function createSyncBridge<TDoc extends VaultDoc, TMeta extends VaultMetadata>(
  options: SyncBridgeOptions<TDoc, TMeta>,
): SyncBridgeService<TDoc, TMeta> {
  return new SyncBridgeService(options)
}
