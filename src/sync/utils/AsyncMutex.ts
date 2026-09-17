/**
 * AsyncMutex guarantees sequential, mutually-exclusive execution of asynchronous tasks (FIFO).
 */
export class AsyncMutex {
  private tail: Promise<unknown> = Promise.resolve()

  /**
   * Runs the task exclusively once all previously queued tasks have completed (even if they rejected).
   * Returns a promise that settles with the task's result or rejection.
   */
  async runExclusive<T>(task: () => Promise<T> | T): Promise<T> {
    const prev = this.tail
    const resultPromise = (async () => {
      await prev.catch(() => {})
      return task()
    })()
    this.tail = resultPromise.catch(() => {})
    return resultPromise
  }

  /**
   * Awaits completion of all currently queued tasks in the mutex.
   */
  async waitForIdle(): Promise<void> {
    await this.tail.catch(() => {})
  }
}

/**
 * KeyedAsyncMutex provides keyed mutual exclusion, guaranteeing that tasks for the
 * same key run sequentially in FIFO order, while tasks with different keys run concurrently.
 */
export class KeyedAsyncMutex<K> {
  private locks = new Map<K, Promise<unknown>>()

  /**
   * Runs the task exclusively for the given key.
   */
  async runExclusive<T>(key: K, task: () => Promise<T> | T): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve()
    let release!: () => void
    const lockPromise = new Promise<void>(resolve => {
      release = resolve
    })
    const nextLock = prev.catch(() => {}).then(() => lockPromise)
    this.locks.set(key, nextLock)

    try {
      await prev.catch(() => {})
      return await task()
    } finally {
      release()
      if (this.locks.get(key) === nextLock) {
        this.locks.delete(key)
      }
    }
  }

  /**
   * Awaits completion of any currently running or queued task for the given key.
   */
  async waitForIdle(key: K): Promise<void> {
    const lock = this.locks.get(key)
    if (lock) {
      await lock.catch(() => {})
    }
  }

  /**
   * Clears in-flight lock tracking for a key, or all keys if omitted.
   */
  clear(key?: K): void {
    if (key !== undefined) {
      this.locks.delete(key)
    } else {
      this.locks.clear()
    }
  }
}
