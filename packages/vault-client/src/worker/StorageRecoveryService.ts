import type { ItemId } from '@vault/shared'
import { isQuotaError } from '../utils/storageQuota'
import { resetQuotaExceededStatus, registerQuotaReporter } from '../utils/storageManager'
import type { ClientEventHub } from './SyncEventHub'
import type { ChangeOutbox } from './ChangeOutbox'
import type { AutomergeDocStore } from './docStore'
import type { ItemSyncState } from './ItemSyncState'
import type { SnapshotPusher } from './SnapshotPusher'
import type { SnapshotSchedule } from './SnapshotSchedule'
import type { ScopedMetadataStore } from './stores/syncMetadataStorage'
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
  itemSyncState: Pick<ItemSyncState, 'save'>
  snapshotSchedule: Pick<SnapshotSchedule, 'getDirtyItemIds'>
  snapshotPusher: Pick<SnapshotPusher, 'flushPendingSnapshots'>
  /** Any store in the sync metadata database, written to probe whether storage has room again */
  metadataStore: Pick<ScopedMetadataStore<unknown>, 'testStorageAvailable'>
  orchestrator: SyncOrchestrator
}

export class StorageRecoveryService {
  private unregisterQuotaReporter: (() => void) | null = null
  /**
   * Items edited in this tab since the last successful retry. An edit's doc and pending mark can both
   * fail to save while storage is full, and only the leader's acknowledged pushes queue snapshots, so
   * the dirty queue alone would miss them.
   */
  private readonly editedItems = new Set<ItemId>()

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
    this.editedItems.clear()
  }

  /** Records an edit in this tab, whose doc a later `retrySave` saves again */
  recordEdit(itemId: ItemId): void {
    this.editedItems.add(itemId)
  }

  /**
   * Saves what failed to save while storage was full, once it has room again: the documents edited in
   * this tab and those queued for a snapshot, then the items' sync records. Their pending marks may
   * have failed too, so they're written again.
   */
  async retrySave(): Promise<RetrySaveResult> {
    try {
      await rethrowQuota(
        this.deps.metadataStore.testStorageAvailable(),
        'Storage quota is still exceeded. Please free up more space on your device.',
      )
      const edited = Array.from(this.editedItems)
      const dirtyIds = Array.from(new Set([...edited, ...this.deps.snapshotSchedule.getDirtyItemIds()]))
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
        this.deps.itemSyncState.save(),
        'Storage quota is still exceeded while saving sync records.',
      )
      if (this.deps.session.isOnline) {
        fireAndForget(
          this.deps.snapshotPusher.flushPendingSnapshots(),
          'StorageRecoveryService:flushPendingSnapshots',
        )
        this.deps.orchestrator.flush()
      }

      for (const itemId of edited) {
        this.editedItems.delete(itemId)
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
