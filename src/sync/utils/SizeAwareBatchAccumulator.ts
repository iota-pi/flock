export interface SizeAwareBatchAccumulatorOptions<T> {
  maxBatchCount?: number
  maxBatchBytes?: number
  maxPayloadLimit?: number
  calculateSize?: (item: T) => number
}

export const DEFAULT_MAX_BATCH_COUNT = 25
export const DEFAULT_MAX_BATCH_BYTES = 350 * 1024 // 350 KB
export const DEFAULT_MAX_PAYLOAD_LIMIT = 2 * 1024 * 1024 // 2 MB

export class SizeAwareBatchAccumulator<T> {
  private currentBatch: T[] = []
  private currentBatchBytes = 0
  public readonly maxBatchCount: number
  public readonly maxBatchBytes: number
  public readonly calculateSize?: (item: T) => number

  constructor(
    optionsOrCalculateSize?:
      | SizeAwareBatchAccumulatorOptions<T>
      | ((item: T) => number),
  ) {
    const options: SizeAwareBatchAccumulatorOptions<T> =
      typeof optionsOrCalculateSize === 'function'
        ? { calculateSize: optionsOrCalculateSize }
        : optionsOrCalculateSize ?? {}

    this.maxBatchCount = options.maxBatchCount ?? DEFAULT_MAX_BATCH_COUNT
    const payloadLimit = options.maxPayloadLimit ?? DEFAULT_MAX_PAYLOAD_LIMIT
    const requestedMax = options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES
    this.maxBatchBytes = Math.min(requestedMax, payloadLimit)
    this.calculateSize = options.calculateSize
  }

  get items(): readonly T[] {
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

  private getItemSize(itemOrSize: T | number, explicitSize?: number): number {
    if (explicitSize !== undefined) {
      return Math.max(0, explicitSize)
    }
    if (typeof itemOrSize === 'number') {
      return Math.max(0, itemOrSize)
    }
    if (this.calculateSize) {
      return Math.max(0, this.calculateSize(itemOrSize))
    }
    throw new Error(
      'SizeAwareBatchAccumulator: No calculateSize function provided and item is not a number',
    )
  }

  wouldExceed(itemOrSize: T | number, explicitSize?: number): boolean {
    const size = this.getItemSize(itemOrSize, explicitSize)
    const wouldExceedCount = this.currentBatch.length >= this.maxBatchCount
    const wouldExceedBytes = this.currentBatchBytes + size > this.maxBatchBytes
    return wouldExceedCount || wouldExceedBytes
  }

  push(item: T, explicitSize?: number): void {
    const size = this.getItemSize(item, explicitSize)
    this.currentBatch.push(item)
    this.currentBatchBytes += size
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
   * Partitions an iterable of items into batches adhering to maxBatchCount and maxBatchBytes.
   */
  accumulateAll(items: Iterable<T>): T[][] {
    const batches: T[][] = []
    for (const item of items) {
      if (this.wouldExceed(item) && !this.isEmpty) {
        batches.push(this.drain())
      }
      this.push(item)
    }
    if (!this.isEmpty) {
      batches.push(this.drain())
    }
    return batches
  }

  /**
   * Helper static method to batch items using SizeAwareBatchAccumulator.
   */
  static batch<T>(
    items: Iterable<T>,
    options?: SizeAwareBatchAccumulatorOptions<T> | ((item: T) => number),
  ): T[][] {
    const accumulator = new SizeAwareBatchAccumulator<T>(options)
    return accumulator.accumulateAll(items)
  }
}
