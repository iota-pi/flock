/**
 * Centralized sync configuration constants.
 * Grouped into timeouts and batch sizes for unified management and testability.
 */

export const SYNC_TIMEOUTS = {
  /** Fast-path document lookup timeout in AutomergeDocStore */
  docStoreFastPath: 2000,
  /** Extended document lookup timeout when document is confirmed to exist in storage */
  docStoreExtended: 8000,
  /** Document lookup timeout for a snapshot build: the doc store's whole budget (fast path plus extended) */
  snapshotDocLookup: 10_000,
  /** Timeout for acquiring the cross-tab account index Web Lock */
  indexLock: 10_000,
  /** Timeout when waiting for a missing encryption key version to arrive */
  keyWait: 5000,
  /** Shorter key wait during manifest hydration, which hydrates many items in one pass */
  hydrationKeyWait: 3000,
  /** Timeout for the main thread to answer a session token refresh request */
  tokenRefresh: 10_000,
  /** Quarantine cooldown period before allowing manual recovery retries */
  recoveryCooldown: 60_000,
  /** Timeout for deleting IndexedDB databases during account data wipe */
  localDataCleanup: 5000,
  /** Interval between polls while none of the account's tabs on this device is visible */
  hiddenPollInterval: 5 * 60 * 1000,
  /** A tab coming back into view polls only if the last poll finished at least this long ago */
  foregroundPollMinGap: 10_000,
  /** How often a visible tab tells the account's other tabs that it's still visible */
  foregroundPingInterval: 30_000,
  /** Default interval between periodic server manifest reconciliations */
  manifestSyncInterval: 60 * 60 * 1000,
  /**
   * A manifest sync (other than a forced one) is skipped this soon after the last clean one. Shorter
   * than `manifestSyncInterval`, which fires just under an interval after the last one finished.
   */
  manifestSyncMinGap: 50 * 60 * 1000,
  /** Delay before auto-restarting worker after crash */
  workerRestartDelay: 1000,
  /** Timeout for graceful worker shutdown before forcing termination */
  workerShutdown: 1000,
  /** How long counting unsynced changes waits for pending snapshots to upload first */
  unsyncedChangesFlush: 5000,
  /** Debounce before recounting the changes waiting to sync, after something that may have changed them */
  syncProgressDebounce: 300,
  /** How often the changes waiting to sync are recounted anyway, so a tab sees what the account's other tabs pushed */
  syncProgressInterval: 15000,
  /** Debounce before uploading a snapshot that manifest sync found missing or newer on this device */
  upstreamSnapshotDebounce: 2000,
} as const

export const SYNC_BATCH_SIZES = {
  /** Number of items to query per poll chunk from sync messages */
  pollChunk: 5,
  /** Maximum entry count in the write-ahead log before pruning */
  walMax: 2000,
  /** Number of oldest WAL entries to prune on buffer overflow */
  walPrune: 100,
  /** Number of snapshots to re-encrypt and upload per batch */
  reencryptChunk: 10,
  /** Maximum number of pending item updates to buffer before flushing to store */
  itemUpdateBatchMax: 50,
  /** Number of remote snapshots to fetch per request when hydrating the manifest */
  hydrationFetch: 50,
  /** Maximum number of items to hydrate concurrently in Automerge WASM */
  hydrationConcurrency: 10,
} as const
