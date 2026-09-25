/**
 * Centralized sync configuration constants.
 * Grouped into timeouts and batch sizes for unified management and testability.
 */

export const SYNC_TIMEOUTS = {
  /** Fast-path document lookup timeout in AutomergeDocStore */
  docStoreFastPath: 2000,
  /** Extended document lookup timeout when document is confirmed to exist in storage */
  docStoreExtended: 8000,
  /** Timeout when waiting for a missing encryption key version to arrive */
  keyWait: 5000,
  /** Quarantine cooldown period before allowing manual recovery retries */
  recoveryCooldown: 60_000,
  /** Timeout for deleting IndexedDB databases during account data wipe */
  localDataCleanup: 5000,
  /** Default interval between periodic server manifest reconciliations */
  manifestSyncInterval: 60 * 60 * 1000,
  /** Delay before auto-restarting worker after crash */
  workerRestartDelay: 1000,
  /** Timeout for graceful worker shutdown before forcing termination */
  workerShutdown: 1000,
} as const

export const SYNC_BATCH_SIZES = {
  /** Number of items to query per poll chunk from sync messages */
  pollChunk: 5,
  /** Maximum entry count in the write-ahead log before compaction and pruning */
  walMax: 2000,
  /** Number of oldest WAL entries to prune on buffer overflow */
  walPrune: 100,
  /** Number of snapshots to re-encrypt and upload per batch */
  reencryptChunk: 10,
  /** Maximum number of pending item updates to buffer before flushing to store */
  itemUpdateBatchMax: 50,
} as const

export type SyncTimeouts = typeof SYNC_TIMEOUTS
export type SyncBatchSizes = typeof SYNC_BATCH_SIZES
