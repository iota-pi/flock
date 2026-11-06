import { isQuotaError } from '../utils/storageQuota'
import { resetQuotaExceededStatus, registerQuotaReporter } from '../utils/storageManager'
import type { ClientEventHub } from './SyncEventHub'
import type { ChangeOutbox } from './ChangeOutbox'
import type { AutomergeDocStore } from './docStore'
import type { SnapshotManager } from './SnapshotManager'
import type { LastModifiedStore } from './stores/LastModifiedStore'
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
  outbox: Pick<ChangeOutbox, 'markAll'>
  docStore: AutomergeDocStore
  snapshotManager: SnapshotManager
  lastModifiedStore: LastModifiedStore
  orchestrator: SyncOrchestrator
}

export class StorageRecoveryService {
  private unregisterQuotaReporter: (() => void) | null = null

  constructor(private readonly deps: StorageRecoveryServiceDeps) {}

  /** Registers the global storage handler that reports a quota error to the client */
  start(): void {
    this.unregisterQuotaReporter = registerQuotaReporter(message => {
      log.warn('Storage quota exceeded')
      this.deps.clientEventHub.emit({ type: 'quotaExceeded', message })
    })
  }

  /** Unregisters the global storage handler */
  stop(): void {
    this.unregisterQuotaReporter?.()
  }

  /**
   * Saves what failed to save while storage was full, once it has room again: the dirty documents,
   * then the timestamps. Their pending marks may have failed too, so they're written again.
   */
  async retrySave(): Promise<RetrySaveResult> {
    try {
      await rethrowQuota(
        this.deps.lastModifiedStore.testStorageAvailable(),
        'Storage quota is still exceeded. Please free up more space on your device.',
      )
      const dirtyIds = this.deps.snapshotManager.tracker.getDirtyItemIds()
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
      await rethrowQuota(this.deps.outbox.markAll(dirtyIds), 'Storage quota is still exceeded while saving changes.')

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
