import type { ItemId, VaultSnapshotInput } from '@vault/shared'
import type { SyncApiClient } from './SyncApiClient'

/** A snapshot to upload. `tick` is the dirty tick it was built at, when it was built for a dirty item. */
export interface UploadableSnapshot {
  snapshot: VaultSnapshotInput
  tick?: number
  heads?: string[]
}

/** Records snapshots the server stored, with the versions it assigned them and the log's head after them */
export interface StoredSnapshotRecorder {
  recordStoredSnapshots(stored: UploadableSnapshot[], versions: Map<ItemId, number>, logSeq: number): void
}

export interface SnapshotBatchResult<T> {
  /** Whether the server stored the whole batch */
  success: boolean
  persisted: number
  stored: T[]
  rejected: T[]
}

export interface UploadSnapshotBatchOptions {
  accountId: string
  apiClient: SyncApiClient
  recorder?: StoredSnapshotRecorder
  signal?: AbortSignal
}

/**
 * Sends a batch of snapshots and records the ones the server stored. The server stores each snapshot
 * on its own, so a response can store some and reject others. Throws if the request fails; retrying
 * is the caller's choice.
 */
export async function uploadSnapshotBatch<T extends UploadableSnapshot>(
  batch: T[],
  options: UploadSnapshotBatchOptions,
): Promise<SnapshotBatchResult<T>> {
  const response = await options.apiClient.putSnapshots(
    { account: options.accountId, snapshots: batch.map(item => item.snapshot) },
    { signal: options.signal },
  )

  const versions = new Map(response.results.map(r => [r.itemId, r.version]))
  const stored = batch.filter(item => versions.has(item.snapshot.itemId))
  if (stored.length > 0) {
    options.recorder?.recordStoredSnapshots(stored, versions, response.logSeq)
  }

  return {
    success: response.success && response.persisted === batch.length,
    persisted: response.persisted,
    stored,
    rejected: batch.filter(item => !versions.has(item.snapshot.itemId)),
  }
}
