export interface SingleFlightOptions {
  /**
   * Callback invoked when a concurrent caller coalesces onto an already running promise.
   */
  onCoalesce?: () => void
}

/**
 * SingleFlightGuard (TaskDeduplicator) guarantees that only one instance of an
 * asynchronous operation is in flight at any given time. Concurrent invocations
 * coalesce onto the single running promise rather than kicking off duplicate work.
 */
export class SingleFlightGuard<T = void> {
  private running: Promise<T> | null = null

  /**
   * Whether an operation is currently in flight.
   */
  get isRunning(): boolean {
    return this.running !== null
  }

  /**
   * The active in-flight promise, or null if idle.
   */
  get currentPromise(): Promise<T> | null {
    return this.running
  }

  /**
   * Executes an async operation, or returns the in-flight promise if one is already running.
   *
   * @param fn The async operation to execute.
   * @param options Optional configuration, such as an onCoalesce callback.
   */
  async run(fn: () => Promise<T>, options?: SingleFlightOptions): Promise<T> {
    if (this.running) {
      options?.onCoalesce?.()
      return this.running
    }

    let promise: Promise<T>
    try {
      promise = fn()
    } catch (syncErr) {
      return Promise.reject(syncErr)
    }

    this.running = promise

    try {
      return await promise
    } finally {
      if (this.running === promise) {
        this.running = null
      }
    }
  }

  /**
   * Safely awaits any active in-flight promise.
   * Suppresses errors from the in-flight task to ensure teardowns / shutdowns do not crash.
   * Returns the resolved value if successful, or undefined if rejected or idle.
   */
  async waitForRunning(): Promise<T | undefined> {
    if (this.running) {
      try {
        return await this.running
      } catch {
        return undefined
      }
    }
    return undefined
  }

  /**
   * Resets the running state reference without aborting the underlying promise.
   * Useful when demoting leadership, clearing accounts, or tearing down state.
   */
  clear(): void {
    this.running = null
  }
}

/**
 * Alias for SingleFlightGuard.
 */
export const TaskDeduplicator = SingleFlightGuard
export type TaskDeduplicator<T = void> = SingleFlightGuard<T>

/**
 * KeyedSingleFlightGuard guarantees that only one instance of an asynchronous
 * operation for a given key is in flight at any given time. Concurrent invocations
 * with the same key coalesce onto the single running promise.
 */
export class KeyedSingleFlightGuard<K, T = void> {
  private running = new Map<K, Promise<T>>()

  /**
   * Whether an operation for the given key is currently in flight.
   */
  isRunning(key: K): boolean {
    return this.running.has(key)
  }

  /**
   * The set of keys currently executing operations in flight.
   */
  get activeKeys(): ReadonlySet<K> {
    return new Set(this.running.keys())
  }

  /**
   * The active in-flight promise for the key, or undefined if idle.
   */
  getPromise(key: K): Promise<T> | undefined {
    return this.running.get(key)
  }

  /**
   * Executes an async operation for a key, or returns the in-flight promise if one is already running.
   *
   * @param key The partition key for the operation.
   * @param fn The async operation to execute.
   * @param options Optional configuration, such as an onCoalesce callback.
   */
  async run(key: K, fn: () => Promise<T>, options?: SingleFlightOptions): Promise<T> {
    const existing = this.running.get(key)
    if (existing) {
      options?.onCoalesce?.()
      return existing
    }

    let promise: Promise<T>
    try {
      promise = fn()
    } catch (syncErr) {
      return Promise.reject(syncErr)
    }

    this.running.set(key, promise)

    try {
      return await promise
    } finally {
      if (this.running.get(key) === promise) {
        this.running.delete(key)
      }
    }
  }

  /**
   * Safely awaits any active in-flight promise for the key.
   * Suppresses errors from the in-flight task to ensure teardowns / shutdowns do not crash.
   * Returns the resolved value if successful, or undefined if rejected or idle.
   */
  async waitForRunning(key: K): Promise<T | undefined> {
    const promise = this.running.get(key)
    if (promise) {
      try {
        return await promise
      } catch {
        return undefined
      }
    }
    return undefined
  }

  /**
   * Resets running state reference(s) without aborting the underlying promises.
   * If a key is passed, clears only that key. Otherwise clears all keys.
   */
  clear(key?: K): void {
    if (key !== undefined) {
      this.running.delete(key)
    } else {
      this.running.clear()
    }
  }
}

