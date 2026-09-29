import type { ItemId } from 'src/shared/schemas/items'
import { toDocumentIdFromItemId } from './utils/automerge'
import { isQuotaError } from '../../utils/storageQuota'
import {
  resetQuotaExceededStatus,
  registerQuotaRecoveryHandler,
  registerQuotaReporter,
} from '../../utils/storageManager'
import type { ClientEventHub } from './SyncEventHub'
import type { SyncWriteAheadLog } from './SyncWriteAheadLog'
import type { AutomergeDocStore } from './docStore'
import type { SnapshotManager } from './SnapshotManager'
import type { LastModifiedStore } from './stores/LastModifiedStore'
import type { SyncMessageBroker } from './SyncMessageBroker'
import type { VaultNetworkAdapter } from './VaultNetworkAdapter'
import type { SyncOrchestrator } from './SyncOrchestrator'
import type { LifecycleAware } from './ServiceLifecycleManager'

export class QuotaExceededRetryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QuotaExceededRetryError'
  }
}

export interface StorageRecoveryServiceDeps {
  accountId: string
  clientEventHub: ClientEventHub
  wal: SyncWriteAheadLog
  docStore: AutomergeDocStore
  snapshotManager: SnapshotManager
  lastModifiedStore: LastModifiedStore
  broker: SyncMessageBroker
  adapter: VaultNetworkAdapter
  orchestrator: SyncOrchestrator
  onQuotaStatusChange?: (isQuotaExceeded: boolean) => void
}

export class StorageRecoveryService implements LifecycleAware {
  readonly lifecycleName = 'StorageRecoveryService'
  private isQuotaExceeded = false
  private unregisterQuotaRecovery: (() => void) | null = null
  private unregisterQuotaReporter: (() => void) | null = null

  constructor(private readonly deps: StorageRecoveryServiceDeps) {}

  onLifecycleStart(): void {
    this.start()
  }

  onLifecycleStop(): void {
    this.stop()
  }

  /**
   * Starts the service and registers global storage handlers.
   */
  start(): void {
    if (!this.unregisterQuotaRecovery) {
      this.unregisterQuotaRecovery = registerQuotaRecoveryHandler(async () => {
        return this.handleEmergencyCompaction()
      })
    }

    if (!this.unregisterQuotaReporter) {
      this.unregisterQuotaReporter = registerQuotaReporter((msg: string) => {
        void this.handleQuotaExceeded(msg)
      })
    }
  }

  /**
   * Stops the service and unregisters global storage handlers.
   */
  stop(): void {
    if (this.unregisterQuotaRecovery) {
      this.unregisterQuotaRecovery()
      this.unregisterQuotaRecovery = null
    }
    if (this.unregisterQuotaReporter) {
      this.unregisterQuotaReporter()
      this.unregisterQuotaReporter = null
    }
  }

  getQuotaExceeded(): boolean {
    return this.isQuotaExceeded
  }

  /**
   * Performs emergency WAL compaction and pruning to free storage space.
   */
  async handleEmergencyCompaction(): Promise<number> {
    try {
      return await this.deps.wal.handleQuotaExceeded()
    } catch (err) {
      console.error('[StorageRecoveryService] Error during emergency WAL compaction:', err)
      throw err
    }
  }

  /**
   * Handles storage quota exceeded detection: runs WAL compaction,
   * updates status manager, and emits quotaExceeded event.
   */
  async handleQuotaExceeded(errorOrMessage?: unknown): Promise<void> {
    console.warn('[StorageRecoveryService] Storage quota exceeded. Running emergency WAL compaction...', errorOrMessage)
    this.isQuotaExceeded = true
    this.deps.onQuotaStatusChange?.(true)

    try {
      await this.handleEmergencyCompaction()
    } catch (compactionErr) {
      console.error('[StorageRecoveryService] Failed emergency compaction during quota handling:', compactionErr)
    }

    const message =
      typeof errorOrMessage === 'string'
        ? errorOrMessage
        : 'Storage quota exceeded. Flock cannot save changes or synchronize, risking data loss. Please free up space and check your connection to sync.'

    this.deps.clientEventHub.emit({
      type: 'quotaExceeded',
      message,
    })
  }

  /**
   * Probes storage availability before attempting full persistence.
   */
  async probeStorageAvailability(): Promise<void> {
    try {
      await this.deps.lastModifiedStore.testStorageAvailable()
    } catch (probeErr) {
      if (isQuotaError(probeErr)) {
        throw new QuotaExceededRetryError(
          'Storage quota is still exceeded. Please free up more space on your device.'
        )
      }
      throw probeErr
    }
  }

  /**
   * Resets broker and network renegotiation circuits once storage is available.
   */
  resetStorageCircuits(): void {
    this.deps.broker.unblockAllItems?.()
    this.deps.adapter.resetReNegotiationCircuit?.()
  }

  /**
   * Persists dirty Automerge documents to local IndexedDB storage.
   */
  async persistDirtyDocuments(dirtyIds: ItemId[]): Promise<void> {
    for (const itemId of dirtyIds) {
      try {
        await this.deps.docStore.saveDocToStorage(itemId)
      } catch (saveErr) {
        if (isQuotaError(saveErr)) {
          throw new QuotaExceededRetryError('Storage quota is still exceeded while saving documents.')
        }
        console.warn(`[StorageRecoveryService] Failed to save doc for item ${itemId} during retrySave`, saveErr)
      }
    }
  }

  /**
   * Triggers Automerge renegotiation so sync messages are queued into the WAL.
   */
  triggerRenegotiations(dirtyIds: ItemId[]): void {
    for (const itemId of dirtyIds) {
      const documentId = toDocumentIdFromItemId(itemId)
      this.deps.adapter.triggerReNegotiation?.(documentId)
    }
  }

  /**
   * Persists timestamps metadata.
   */
  async persistTimestamps(): Promise<void> {
    try {
      await this.deps.snapshotManager.persistLastModified()
    } catch (tsErr) {
      if (isQuotaError(tsErr)) {
        throw new QuotaExceededRetryError('Storage quota is still exceeded while saving timestamps.')
      }
      throw tsErr
    }
  }

  /**
   * If online, flushes pending snapshots and triggers orchestrator sync.
   */
  flushPendingSyncIfOnline(): void {
    if (this.deps.orchestrator.online) {
      void this.deps.snapshotManager.flushPendingSnapshots().catch(console.error)
      this.deps.orchestrator.flush()
    }
  }

  /**
   * Resets global quota status and notifies client.
   */
  resolveQuotaStatus(): void {
    resetQuotaExceededStatus()
    this.isQuotaExceeded = false
    this.deps.onQuotaStatusChange?.(false)
    this.deps.clientEventHub.emit({ type: 'quotaResolved' })
  }

  /**
   * Executes the full retry persistence flow:
   * 1. probeStorageAvailability()
   * 2. resetStorageCircuits()
   * 3. persistDirtyDocuments(dirtyIds)
   * 4. triggerRenegotiations(dirtyIds)
   * 5. persistTimestamps()
   * 6. flushPendingSyncIfOnline()
   * 7. resolveQuotaStatus()
   */
  async retrySave(): Promise<{ success: boolean; error?: string }> {
    try {
      await this.probeStorageAvailability()
      const blockedIds = this.deps.broker.getBlockedItemIds?.() ?? []
      this.resetStorageCircuits()

      const dirtyIds = Array.from(
        new Set([...this.deps.snapshotManager.getDirtyItemIds(), ...blockedIds])
      )
      await this.persistDirtyDocuments(dirtyIds)
      this.triggerRenegotiations(dirtyIds)

      await this.persistTimestamps()
      this.flushPendingSyncIfOnline()

      this.resolveQuotaStatus()
      return { success: true }
    } catch (err) {
      if (err instanceof QuotaExceededRetryError) {
        return { success: false, error: err.message }
      }
      console.error('[StorageRecoveryService] Unexpected error during retrySave', err)
      return { success: false, error: (err as Error).message || 'Failed to retry save' }
    }
  }
}
