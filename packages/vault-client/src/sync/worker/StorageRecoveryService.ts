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
   * Registers the global storage handlers: a quota error prunes the WAL before its one retry, and a
   * quota error that persists is reported to the client.
   */
  start(): void {
    this.unregisterQuotaRecovery = registerQuotaRecoveryHandler(async () => {
      await this.deps.wal.handleQuotaExceeded()
    })
    this.unregisterQuotaReporter = registerQuotaReporter(message => {
      log.warn('Storage quota exceeded')
      this.deps.clientEventHub.emit({ type: 'quotaExceeded', message })
    })
  }

  /**
   * Unregisters the global storage handlers.
   */
  stop(): void {
    this.unregisterQuotaRecovery?.()
    this.unregisterQuotaReporter?.()
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
        new Set([...this.deps.snapshotManager.tracker.getDirtyItemIds(), ...blockedIds])
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
        this.deps.snapshotManager.tracker.saveLastModified(),
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
