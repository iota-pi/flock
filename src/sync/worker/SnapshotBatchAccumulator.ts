import {
  SizeAwareBatchAccumulator,
  type SizeAwareBatchAccumulatorOptions,
  DEFAULT_MAX_BATCH_COUNT,
  DEFAULT_MAX_PAYLOAD_LIMIT,
} from '../utils/SizeAwareBatchAccumulator'
import type { VaultSnapshotInput } from '../../shared/schemas/snapshots'

export interface PreparedSnapshotItem {
  snapshot: VaultSnapshotInput
  tick: number
  heads?: string[]
}

export type SnapshotBatchAccumulatorOptions =
  SizeAwareBatchAccumulatorOptions<PreparedSnapshotItem>

export const DEFAULT_MAX_SNAPSHOT_BATCH_COUNT = DEFAULT_MAX_BATCH_COUNT
export const DEFAULT_MAX_SNAPSHOT_PAYLOAD_LIMIT = DEFAULT_MAX_PAYLOAD_LIMIT

/**
 * Direct ciphertext length estimation.
 * Estimates the serialized JSON size by calculating ciphertext length plus base metadata/envelope overhead (~128 bytes),
 * avoiding costly `JSON.stringify(snapshot)` string allocations.
 */
export function estimateSnapshotSize(snapshot: VaultSnapshotInput): number {
  const BASE_OVERHEAD_BYTES = 128
  const cipherBytes = snapshot.snapshot?.cipher?.length ?? 0
  const ivBytes = snapshot.snapshot?.iv?.length ?? 0
  const idBytes = snapshot.itemId?.length ?? 0
  return cipherBytes + ivBytes + idBytes + BASE_OVERHEAD_BYTES
}

export class SnapshotBatchAccumulator extends SizeAwareBatchAccumulator<PreparedSnapshotItem> {
  constructor(options?: SnapshotBatchAccumulatorOptions) {
    super({
      ...options,
      calculateSize: options?.calculateSize ?? (item => estimateSnapshotSize(item.snapshot)),
    })
  }
}
