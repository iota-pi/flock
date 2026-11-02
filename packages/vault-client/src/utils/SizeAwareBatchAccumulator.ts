import { MAX_ITEM_SIZE_BYTES } from '@vault/shared'

export interface SizeAwareBatchAccumulatorOptions {
  maxBatchCount?: number
  maxBatchBytes?: number
}

export const DEFAULT_MAX_BATCH_COUNT = 25
export const DEFAULT_MAX_BATCH_BYTES = MAX_ITEM_SIZE_BYTES

export class SizeAwareBatchAccumulator<T> {
  private currentBatch: T[] = []
  private currentBatchBytes = 0
  public readonly maxBatchCount: number
  public readonly maxBatchBytes: number

  constructor(options: SizeAwareBatchAccumulatorOptions = {}) {
    this.maxBatchCount = options.maxBatchCount ?? DEFAULT_MAX_BATCH_COUNT
    this.maxBatchBytes = options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES
  }

  get items(): readonly T[] {
    return this.currentBatch
  }

  get size(): number {
    return this.currentBatch.length
  }

  get isEmpty(): boolean {
    return this.currentBatch.length === 0
  }

  wouldExceed(size: number): boolean {
    const wouldExceedCount = this.currentBatch.length >= this.maxBatchCount
    const wouldExceedBytes = this.currentBatchBytes + Math.max(0, size) > this.maxBatchBytes
    return wouldExceedCount || wouldExceedBytes
  }

  push(item: T, size: number): void {
    this.currentBatch.push(item)
    this.currentBatchBytes += Math.max(0, size)
  }

  drain(): T[] {
    const batch = this.currentBatch
    this.currentBatch = []
    this.currentBatchBytes = 0
    return batch
  }

  clear(): void {
    this.currentBatch = []
    this.currentBatchBytes = 0
  }

  /**
   * Partitions items into batches adhering to maxBatchCount and maxBatchBytes.
   */
  static batch<T>(
    items: Iterable<T>,
    options: SizeAwareBatchAccumulatorOptions & { calculateSize: (item: T) => number },
  ): T[][] {
    const accumulator = new SizeAwareBatchAccumulator<T>(options)
    const batches: T[][] = []
    for (const item of items) {
      const size = options.calculateSize(item)
      if (accumulator.wouldExceed(size) && !accumulator.isEmpty) {
        batches.push(accumulator.drain())
      }
      accumulator.push(item, size)
    }
    if (!accumulator.isEmpty) {
      batches.push(accumulator.drain())
    }
    return batches
  }
}
