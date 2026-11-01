import { toDocumentIdFromItemId } from './utils/automerge'
import { isQuotaError } from '../utils/storageQuota'
import {
  resetQuotaExceededStatus,
  registerQuotaRecoveryHandler,
  registerQuotaReporter,
} from '../utils/storageManager'
import type { ClientEventHub } from './SyncEventHub'
import type { SyncWriteAheadLog } from './SyncWriteAheadLog'
import type { AutomergeDocStore } from './docStore'
import type { SnapshotManager } from './SnapshotManager'
import type { LastModifiedStore } from './stores/LastModifiedStore'
import type { SyncMessageBroker } from './SyncMessageBroker'
import type { VaultNetworkAdapter } from './VaultNetworkAdapter'
import type { SyncOrchestrator } from './SyncOrchestrator'
import type { RetrySaveResult } from './syncProtocol'
import { fireAndForget } from '../utils/fireAndForget'
import { createLogger } from '../utils/logger'
import { errorMessage } from '../utils/errorMessage'
import type { SyncSessionState } from './SyncSessionState'

const log = createLogger('StorageRecoveryService')

class QuotaExceededRetryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QuotaExceededRetryError'
  }
}

export interface StorageRecoveryServiceDeps {
  accountId: string
  session: SyncSessionState
  clientEventHub: ClientEventHub
  wal: SyncWriteAheadLog
  docStore: AutomergeDocStore
  snapshotManager: SnapshotManager
  lastModifiedStore: LastModifiedStore
  broker: SyncMessageBroker
  adapter: VaultNetworkAdapter
  orchestrator: SyncOrchestrator
}

export class StorageRecoveryService {
  private unregisterQuotaRecovery: (() => void) | null = null
  private unregisterQuotaReporter: (() => void) | null = null

  constructor(private readonly deps: StorageRecoveryServiceDeps) {}

  /**
   * Starts the service and registers global storage handlers.
   */
  start(): void {
    if (!this.unregisterQuotaRecovery) {
      this.unregisterQuotaRecovery = registerQuotaRecoveryHandler(async () => {
        return this.handleEmergencyPrune()
      })
    }

    if (!this.unregisterQuotaReporter) {
      this.unregisterQuotaReporter = registerQuotaReporter((msg: string) => {
        fireAndForget(this.handleQuotaExceeded(msg), 'StorageRecoveryService:handleQuotaExceeded')
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

  /**
   * Performs emergency WAL pruning to free storage space. Returns the number of entries removed.
   */
  async handleEmergencyPrune(): Promise<number> {
    try {
      return await this.deps.wal.handleQuotaExceeded()
    } catch (err) {
      log.error('Error during emergency WAL pruning:', err)
      throw err
    }
  }

  /**
   * Handles storage quota exceeded detection: prunes the WAL and emits a quotaExceeded event.
   */
  async handleQuotaExceeded(errorOrMessage?: unknown): Promise<void> {
    log.warn('Storage quota exceeded. Pruning the WAL...', errorOrMessage)

    try {
      await this.handleEmergencyPrune()
    } catch (pruneErr) {
      log.error('Failed emergency WAL pruning during quota handling:', pruneErr)
    }

    const message =
      typeof errorOrMessage === 'string'
        ? errorOrMessage
        : 'Storage quota exceeded. Changes cannot be saved or synchronized, risking data loss. Please free up space and check your connection to sync.'

    this.deps.clientEventHub.emit({
      type: 'quotaExceeded',
      message,
    })
  }

  /**
   * Saves what failed to save while storage was full, once it has room again: the dirty and blocked
   * documents, then the timestamps, and queues their sync messages into the WAL
   */
  async retrySave(): Promise<RetrySaveResult> {
    try {
      await rethrowQuota(
        this.deps.lastModifiedStore.testStorageAvailable(),
        'Storage quota is still exceeded. Please free up more space on your device.',
      )
      const blockedIds = this.deps.broker.getBlockedItemIds()
      this.deps.broker.unblockAllItems()
      this.deps.adapter.resetReNegotiationCircuit()

      const dirtyIds = Array.from(
        new Set([...this.deps.snapshotManager.getDirtyItemIds(), ...blockedIds])
      )
      for (const itemId of dirtyIds) {
        try {
          await this.deps.docStore.saveDocToStorage(itemId)
        } catch (saveErr) {
          if (isQuotaError(saveErr)) {
            throw new QuotaExceededRetryError('Storage quota is still exceeded while saving documents.')
          }
          log.warn(`Failed to save doc for item ${itemId} during retrySave`, saveErr)
        }
      }
      for (const itemId of dirtyIds) {
        this.deps.adapter.triggerReNegotiation(toDocumentIdFromItemId(itemId))
      }

      await rethrowQuota(
        this.deps.snapshotManager.persistLastModified(),
        'Storage quota is still exceeded while saving timestamps.',
      )
      if (this.deps.session.isOnline) {
        fireAndForget(
          this.deps.snapshotManager.flushPendingSnapshots(),
          'StorageRecoveryService:flushPendingSnapshots',
        )
        this.deps.orchestrator.flush()
      }

      resetQuotaExceededStatus()
      this.deps.clientEventHub.emit({ type: 'quotaResolved' })
      return { success: true }
    } catch (err) {
      if (err instanceof QuotaExceededRetryError) {
        return { success: false, error: err.message }
      }
      log.error('Unexpected error during retrySave', err)
      return { success: false, error: errorMessage(err) || 'Failed to retry save' }
    }
  }
}

/** Settles with `promise`, turning a quota error into a QuotaExceededRetryError with `message` */
async function rethrowQuota(promise: Promise<unknown>, message: string): Promise<void> {
  try {
    await promise
  } catch (err) {
    throw isQuotaError(err) ? new QuotaExceededRetryError(message) : err
  }
}
