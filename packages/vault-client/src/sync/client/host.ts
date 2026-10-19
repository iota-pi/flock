import type { ItemId } from '@vault/shared'
import type { MigrationRequiredReason, SyncStatus, VaultDoc, VaultMetadata } from '../shared/types'

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
  /**
   * Called when sync can't run until the app's migration app has run (see
   * `SyncWorkerConfig.minDataVersion`). The app should stop sync and send the user there.
   */
  onMigrationRequired?(reason: MigrationRequiredReason): void
  /**
   * Called before the sync worker deletes the plaintext stores that sealed ones replaced. The app
   * should ask its other tabs to stop syncing this account: the worker deletes them only once nothing
   * else holds the account's sync locks. Don't make this tab stop.
   */
  beforeRetiringLegacyStores?(accountId: string): void
  /**
   * Called when this device's local data can't be opened, even after reloading the keyring from the
   * server. Sync has stopped. The app should explain, and offer to try again (`initialize`) or, once
   * the user confirms, to discard the local data and download it again (`discardLocalDataAndRestart`).
   * `unpushedChanges` is how many changes that would lose. The data is never discarded automatically.
   */
  onLocalDataUnavailable?(details: { unpushedChanges: number }): void
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
