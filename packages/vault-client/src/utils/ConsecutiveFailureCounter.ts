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

  /**
   * Records a failure and returns whether the key reached `limit`. Reaching it resets the key, so the
   * caller acts on it once and a later failure starts a new run.
   */
  recordFailure(key: K): boolean {
    const failures = this.count(key) + 1
    if (failures >= this.limit) {
      this.counts.delete(key)
      return true
    }
    this.counts.set(key, failures)
    return false
  }

  reset(key: K): void {
    this.counts.delete(key)
  }

  clear(): void {
    this.counts.clear()
  }
}
