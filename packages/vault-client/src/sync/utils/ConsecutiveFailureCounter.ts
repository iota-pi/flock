/**
 * Counts consecutive failures per key, for callers that give up on a key (such as quarantining an item)
 * after `limit` failures in a row. A success resets the key's count.
 */
export class ConsecutiveFailureCounter<K> {
  private readonly counts = new Map<K, number>()

  constructor(readonly limit: number) {}

  /** The key's current run of failures */
  count(key: K): number {
    return this.counts.get(key) ?? 0
  }

  /** How many keys have failed at least once since their last reset */
  get size(): number {
    return this.counts.size
  }

  /**
   * Records a failure and returns the key's new count. Reaching `limit` resets the key, so the caller
   * acts on it once and a later failure starts a new run.
   */
  recordFailure(key: K): number {
    const failures = this.count(key) + 1
    if (failures >= this.limit) {
      this.counts.delete(key)
    } else {
      this.counts.set(key, failures)
    }
    return failures
  }

  /** Whether `failures`, as returned by `recordFailure`, reached the limit */
  isExhausted(failures: number): boolean {
    return failures >= this.limit
  }

  reset(key: K): void {
    this.counts.delete(key)
  }

  clear(): void {
    this.counts.clear()
  }
}
