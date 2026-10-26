import type { ClientEvent } from '../worker/SyncEventHub'
import type { VaultDoc, VaultMetadata } from '../shared/types'
import { noopTelemetry, type SyncStateSink, type SyncTelemetry } from './host'
import type { ManualRecoveryEntry } from '../shared/manualRecoveryStore'
import { SYNC_BATCH_SIZES } from '../shared/syncConfig'
import { createLogger } from '../utils/logger'

const log = createLogger('SyncEventProcessor')

export interface SyncEventProcessorCallbacks {
  onKeyVersionMissing?: (kver?: string) => void
  onLocalDataUnavailable?: (details: { kver?: string, unpushedChanges: number }) => void
  onActivity?: () => void
  onTokenRefreshNeeded?: () => void
}

export class SyncEventProcessor<TDoc extends VaultDoc = VaultDoc, TMeta extends VaultMetadata = VaultMetadata> {
  private readonly ITEM_UPDATE_BATCH_MAX = SYNC_BATCH_SIZES.itemUpdateBatchMax
  private pendingItemUpdates = new Map<string, TDoc | null>()
  private itemUpdateFlushHandle: ReturnType<typeof setTimeout> | null = null

  private recoveryEntries: ManualRecoveryEntry[] = []
  private recoveryEntriesListeners = new Set<(entries: ManualRecoveryEntry[]) => void>()
  private reencryptProgressListeners = new Set<(done: number, total: number) => void>()

  /**
   * The warning a quotaExceeded event set, so quotaResolved clears only that warning. Anything else
   * may replace the warning since (the host, the lifecycle manager or the user dismissing it), so
   * it's compared with the current warning rather than trusted as a flag.
   */
  private quotaWarning: string | null = null

  constructor(
    private readonly sink: SyncStateSink<TDoc, TMeta>,
    private readonly callbacks: SyncEventProcessorCallbacks = {},
    private readonly telemetry: SyncTelemetry = noopTelemetry,
  ) {}

  private setSyncWarning(message: string, fromQuota = false): void {
    this.sink.setSyncWarning(message)
    this.quotaWarning = fromQuota ? message : null
  }

  setRecoveryEntries(entries: ManualRecoveryEntry[]): void {
    this.recoveryEntries = entries
    for (const listener of this.recoveryEntriesListeners) {
      listener(entries)
    }
  }

  subscribeRecoveryItems(listener: (entries: ManualRecoveryEntry[]) => void): () => void {
    this.recoveryEntriesListeners.add(listener)
    listener(this.recoveryEntries)
    return () => {
      this.recoveryEntriesListeners.delete(listener)
    }
  }

  subscribeReencryptProgress(listener: (done: number, total: number) => void): () => void {
    this.reencryptProgressListeners.add(listener)
    return () => {
      this.reencryptProgressListeners.delete(listener)
    }
  }

  flushItemUpdates = (): void => {
    if (this.pendingItemUpdates.size === 0) return

    const updates = Array.from(this.pendingItemUpdates.entries()).map(([id, item]) => ({ id, item }))
    this.pendingItemUpdates.clear()
    this.itemUpdateFlushHandle = null

    this.sink.updateItems(updates)
  }

  private scheduleItemUpdateFlush = (): void => {
    if (this.itemUpdateFlushHandle !== null) return
    this.itemUpdateFlushHandle = setTimeout(this.flushItemUpdates, 0)
  }

  handleSyncEvent = (event: ClientEvent): void => {
    this.callbacks.onActivity?.()
    switch (event.type) {
      case 'ready':
        break
      case 'statusChange':
        this.sink.setSyncStatus(event.status)
        break
      case 'itemUpdated': {
        const { id, item } = event
        // The worker's codec produces the app's document type
        this.pendingItemUpdates.set(id, item as TDoc | null)

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
        this.sink.updateIndex(event.itemIds)
        break
      case 'metadataUpdated':
        this.sink.updateMetadata(event.metadata as TMeta)
        break
      case 'mutationFailed':
        log.error(`Mutation ${event.mutationType} failed: ${event.error}`)
        break
      case 'startRequest':
        this.sink.startRequest()
        break
      case 'finishRequest':
        this.sink.finishRequest()
        break
      case 'authFailure': {
        this.sink.setSyncStatus('offline')
        this.setSyncWarning(event.message)
        this.telemetry.addBreadcrumb({
          category: 'auth',
          message: `Sync auth failure: ${event.message}`,
          level: 'warning',
        })
        break
      }
      case 'recoveryItemsChanged':
        this.setRecoveryEntries(event.entries)
        break
      case 'quotaExceeded': {
        this.sink.setSyncStatus('degraded')
        this.setSyncWarning(event.message, true)
        this.sink.setQuotaExceeded(true)
        this.telemetry.addBreadcrumb({
          category: 'storage',
          message: `Storage quota exceeded: ${event.message}`,
          level: 'warning',
        })
        break
      }
      case 'quotaResolved': {
        this.sink.setQuotaExceeded(false)
        if (this.sink.getSyncStatus() === 'degraded') {
          this.sink.setSyncStatus('idle')
        }
        if (this.quotaWarning !== null && this.sink.getSyncWarning() === this.quotaWarning) {
          this.sink.clearSyncWarning()
        }
        this.quotaWarning = null
        break
      }
      case 'snapshotFailed': {
        this.sink.setSyncStatus('degraded')
        this.setSyncWarning(event.message)
        break
      }
      case 'keyVersionMissing':
        this.callbacks.onKeyVersionMissing?.(event.kver)
        break
      case 'leaderConflict': {
        this.sink.setLeaderConflict(event.hasConflict)
        this.telemetry.setTag('leaderConflict', event.hasConflict)
        break
      }
      case 'tokenRefreshNeeded':
        this.callbacks.onTokenRefreshNeeded?.()
        break
      case 'reencryptProgress':
        for (const listener of Array.from(this.reencryptProgressListeners)) {
          try {
            listener(event.done, event.total)
          } catch (err) {
            log.error('Error in reencryptProgress listener:', err)
          }
        }
        break
      case 'migrationRequired':
        this.telemetry.addBreadcrumb({
          category: 'sync',
          message: `Migration required (${event.reason})`,
          level: 'info',
        })
        this.sink.onMigrationRequired?.(event.reason)
        break
      case 'localDataUnavailable':
        this.telemetry.addBreadcrumb({
          category: 'sync',
          message: `Local data unavailable${event.kver ? ` (key version ${event.kver} missing)` : ''}`,
          level: 'warning',
        })
        this.callbacks.onLocalDataUnavailable?.({ kver: event.kver, unpushedChanges: event.unpushedChanges })
        break
      case 'retiringLegacyStores':
        this.sink.beforeRetiringLegacyStores?.(event.accountId)
        break
      case 'workerError': {
        const error = new Error(event.error.message)
        if (event.error.name) {
          error.name = event.error.name
        }
        if (event.error.stack) {
          error.stack = event.error.stack
        }
        log.error('Worker error received:', error)
        this.telemetry.captureException(error, { origin: 'sync-worker' })
        break
      }
    }
  }

  reset(): void {
    if (this.itemUpdateFlushHandle !== null) {
      clearTimeout(this.itemUpdateFlushHandle)
      this.itemUpdateFlushHandle = null
    }
    this.pendingItemUpdates.clear()
    this.reencryptProgressListeners.clear()
    this.quotaWarning = null

    this.recoveryEntries = []
    for (const listener of this.recoveryEntriesListeners) {
      listener([])
    }
    this.recoveryEntriesListeners.clear()
  }
}
