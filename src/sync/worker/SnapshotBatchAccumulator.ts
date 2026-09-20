import type { VaultSnapshotInput } from '../../shared/schemas/snapshots'

export interface PreparedSnapshotItem {
  snapshot: VaultSnapshotInput
  tick: number
  heads?: string[]
}

export interface SnapshotBatchAccumulatorOptions {
  maxBatchCount?: number
  maxBatchBytes?: number
}

export const DEFAULT_MAX_SNAPSHOT_BATCH_COUNT = 25
export const DEFAULT_MAX_SNAPSHOT_PAYLOAD_LIMIT = 2 * 1024 * 1024 // 2MB

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

export class SnapshotBatchAccumulator {
  private currentBatch: PreparedSnapshotItem[] = []
  private currentBatchBytes = 0
  public readonly maxBatchCount: number
  public readonly maxBatchBytes: number

  constructor(options?: SnapshotBatchAccumulatorOptions) {
    this.maxBatchCount = options?.maxBatchCount ?? DEFAULT_MAX_SNAPSHOT_BATCH_COUNT
    const requestedMax = options?.maxBatchBytes ?? 350 * 1024
    this.maxBatchBytes = Math.min(requestedMax, DEFAULT_MAX_SNAPSHOT_PAYLOAD_LIMIT)
  }

  get items(): readonly PreparedSnapshotItem[] {
    return this.currentBatch
  }

  get size(): number {
    return this.currentBatch.length
  }

  get bytes(): number {
    return this.currentBatchBytes
  }

  get isEmpty(): boolean {
    return this.currentBatch.length === 0
  }

  wouldExceed(itemSizeBytes: number): boolean {
    const wouldExceedCount = this.currentBatch.length >= this.maxBatchCount
    const wouldExceedBytes = this.currentBatchBytes + itemSizeBytes > this.maxBatchBytes
    return wouldExceedCount || wouldExceedBytes
  }

  push(item: PreparedSnapshotItem, itemSizeBytes: number): void {
    this.currentBatch.push(item)
    this.currentBatchBytes += itemSizeBytes
  }

  drain(): PreparedSnapshotItem[] {
    const batch = this.currentBatch
    this.currentBatch = []
    this.currentBatchBytes = 0
    return batch
  }

  clear(): void {
    this.currentBatch = []
    this.currentBatchBytes = 0
  }
}
