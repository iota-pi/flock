import type { ItemId } from '@vault/shared/ids'
import type { SyncStatus, VaultDoc, VaultMetadata } from '../shared/types'

/**
 * Where the main-thread sync client writes the state it receives from the sync worker.
 * Apps typically implement this over their state store.
 */
export interface SyncStateSink<TDoc extends VaultDoc = VaultDoc, TMeta extends VaultMetadata = VaultMetadata> {
  /** Batched document updates. `item` is null when a document was deleted or could not be read. */
  updateItems(updates: Array<{ id: string; item: TDoc | null }>): void
  updateIndex(itemIds: ItemId[]): void
  updateMetadata(metadata: TMeta): void
  getSyncStatus(): SyncStatus
  setSyncStatus(status: SyncStatus): void
  getSyncWarning(): string | null
  setSyncWarning(message: string): void
  clearSyncWarning(): void
  setFatalError(message: string): void
  setQuotaExceeded(exceeded: boolean): void
  setLeaderConflict(hasConflict: boolean): void
  startRequest(): void
  finishRequest(): void
  /** Called when sync shuts down for good, as opposed to an internal restart */
  reset(): void
  /** Called after documents have been restored from a backup */
  onDataRestored?(): void
}

/** Error reporting and diagnostics, for example backed by Sentry */
export interface SyncTelemetry {
  setUser(id: string | null): void
  setTag(key: string, value: string | boolean): void
  addBreadcrumb(breadcrumb: { category: string; message: string; level: 'info' | 'warning' }): void
  captureException(error: unknown, tags?: Record<string, string>): void
}

export const noopTelemetry: SyncTelemetry = {
  setUser: () => {},
  setTag: () => {},
  addBreadcrumb: () => {},
  captureException: () => {},
}
