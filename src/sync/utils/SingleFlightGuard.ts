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
