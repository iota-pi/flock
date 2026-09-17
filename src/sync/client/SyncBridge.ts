import * as Comlink from 'comlink'

import { useAppStore } from 'src/state/store'
import {
  hasVaultKey,
  lockVault,
  reloadKeyringFromStorage,
  syncKeyringFromServer,
} from 'src/api/vault'
import type { Item } from 'src/state/items'
import type { ManualRecoveryEntry } from 'src/sync/shared/manualRecoveryStore'
import type { BackupSyncState } from 'src/types/backup'
import type { ItemId } from 'src/shared/schemas/items'
import type { AccountMetadata } from 'src/state/metadata'
import { WorkerLifecycleManager } from './WorkerLifecycleManager'
import { SyncEventProcessor } from './SyncEventProcessor'
import { SyncDOMListeners } from './SyncDOMListeners'

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
    })

    this.domListeners = new SyncDOMListeners()

    this.lifecycleManager = new WorkerLifecycleManager({
      onEvent: event => {
        this.eventProcessor.handleSyncEvent(event)
      },
      onReady: () => {
        this.domListeners.start({
          onOnlineChange: isOnline => {
            const api = this.lifecycleManager.getSyncApi()
            if (api) void api.setOnlineState(isOnline)
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

  initialize(accountId: string): Promise<void> {
    return this.lifecycleManager.initialize(accountId)
  }

  shutdown(options?: { clearLocalData?: boolean; internalRestart?: boolean; accountId?: string }): Promise<void> {
    return this.lifecycleManager.shutdown(options)
  }

  async listRecoveryItems(): Promise<ManualRecoveryEntry[]> {
    const api = await this.lifecycleManager.ensureReady()
    const entries = await api.listRecoveryItems()
    this.eventProcessor.setRecoveryEntries(entries)
    return entries
  }

  subscribeRecoveryItems(listener: (entries: ManualRecoveryEntry[]) => void): () => void {
    return this.eventProcessor.subscribeRecoveryItems(listener)
  }

  async restoreFromBinaries(documents: Partial<Record<string, string>>) {
    const api = await this.lifecycleManager.ensureReady()
    const result = await api.restoreFromBinaries(documents)
    useAppStore.getState().incrementGeneration()
    return result
  }

  async initRepo(accountId: string, vaultKey: string): Promise<void> {
    const api = await this.lifecycleManager.ensureReady()
    return api.initRepo(accountId, vaultKey)
  }

  async setOnlineState(isOnline: boolean): Promise<void> {
    const api = await this.lifecycleManager.ensureReady()
    return api.setOnlineState(isOnline)
  }

  async bootstrapItems(): Promise<void> {
    const api = await this.lifecycleManager.ensureReady()
    return api.bootstrapItems()
  }

  async mutateItem(id: ItemId, changes: Partial<Item>): Promise<void> {
    const api = await this.lifecycleManager.ensureReady()
    return api.mutateItem(id, changes)
  }

  async createItem(item: Item): Promise<void> {
    const api = await this.lifecycleManager.ensureReady()
    return api.createItem(item)
  }

  async storeItems(items: Item[]): Promise<void> {
    const api = await this.lifecycleManager.ensureReady()
    return api.storeItems(items)
  }

  async mutateMetadata(changes: Partial<AccountMetadata>, options?: { pushRemote?: boolean }): Promise<void> {
    const api = await this.lifecycleManager.ensureReady()
    return api.mutateMetadata(changes, options)
  }

  async exportAllBinaries(): Promise<{ documents: Partial<Record<string, string>>; skipped: string[] }> {
    const api = await this.lifecycleManager.ensureReady()
    return api.exportAllBinaries()
  }

  async flushSync(): Promise<void> {
    const api = await this.lifecycleManager.ensureReady()
    return api.flushSync()
  }

  async fullResync(): Promise<void> {
    const api = await this.lifecycleManager.ensureReady()
    return api.fullResync()
  }

  async pushSnapshots(): Promise<{ persisted: number; total: number }> {
    const api = await this.lifecycleManager.ensureReady()
    return api.pushSnapshots()
  }

  async retrySave(): Promise<{ success: boolean; error?: string }> {
    const api = await this.lifecycleManager.ensureReady()
    return api.retrySave()
  }

  async retryRecoveryItem(itemId: ItemId): Promise<void> {
    const api = await this.lifecycleManager.ensureReady()
    return api.retryRecoveryItem(itemId)
  }

  async forceOverwriteRecoveryItem(itemId: ItemId): Promise<void> {
    const api = await this.lifecycleManager.ensureReady()
    return api.forceOverwriteRecoveryItem(itemId)
  }

  async forceDeleteRecoveryItem(itemId: ItemId): Promise<void> {
    const api = await this.lifecycleManager.ensureReady()
    return api.forceDeleteRecoveryItem(itemId)
  }

  async compactItem(itemId: ItemId): Promise<void> {
    const api = await this.lifecycleManager.ensureReady()
    return api.compactItem(itemId)
  }

  async dismissRecoveryItem(entryId: string): Promise<void> {
    const api = await this.lifecycleManager.ensureReady()
    return api.dismissRecoveryItem(entryId)
  }

  async updateVaultKey(vaultKey: string): Promise<void> {
    const api = await this.lifecycleManager.ensureReady()
    return api.updateVaultKey(vaultKey)
  }

  async reencryptAllItems(onProgress: (done: number, total: number) => void): Promise<{
    succeeded: ItemId[]
    failed: Array<{ itemId: ItemId; error: string }>
  }> {
    const api = await this.lifecycleManager.ensureReady()
    const refreshAuthToken = Comlink.proxy(async () => {
      const { handleSessionExpired, getVaultSession } = await import('src/api/vault')
      await handleSessionExpired()
      return getVaultSession() || null
    })
    return api.reencryptAllItems(Comlink.proxy(onProgress), refreshAuthToken)
  }

  async exportSyncState(): Promise<BackupSyncState> {
    const api = await this.lifecycleManager.ensureReady()
    return api.exportSyncState()
  }

  async restoreSyncState(state: Partial<BackupSyncState>): Promise<void> {
    const api = await this.lifecycleManager.ensureReady()
    return api.restoreSyncState(state)
  }

  async claimLeader(): Promise<void> {
    const api = await this.lifecycleManager.ensureReady()
    return api.claimLeader()
  }
}

export const SyncBridge = new SyncBridgeService()
