export type AsyncQueueWorker<T> = (item: T) => Promise<void> | void

export interface AsyncQueueOptions {
  onError?: (error: unknown, item: any) => void
}

/**
 * A robust FIFO async queue that guarantees sequential item execution.
 *
 * Key features:
 * - Sequential execution: worker is invoked for one item at a time.
 * - In-flight safety: `unshift` preserves the active item at index 0 and inserts behind it,
 *   preventing race conditions where background unshifts displace the running item.
 * - Auto-shift on completion: Items remain at `queue[0]` while being processed / retried,
 *   and are removed once the worker promise settles.
 * - Deadlock-free: The drain loop safely resets processing state in a `finally` block even
 *   on unhandled rejections.
 * - Array-like inspection: Exposes `.length`, `.size`, `.isEmpty`, `[Symbol.iterator]()`,
 *   and indexed access `queue[0]` via a transparent Proxy.
 */
export class AsyncQueue<T> {
  [index: number]: T | undefined

  private items: T[] = []
  private isProcessing = false
  private isCurrentItemRunning = false
  private worker: AsyncQueueWorker<T>
  private options?: AsyncQueueOptions
  private idleResolvers: Array<() => void> = []

  constructor(worker: AsyncQueueWorker<T>, options?: AsyncQueueOptions) {
    this.worker = worker
    this.options = options

    return new Proxy(this, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) {
          const index = Number(prop)
          return target.items[index]
        }
        return Reflect.get(target, prop, receiver)
      },
    })
  }

  get length(): number {
    return this.items.length
  }

  get size(): number {
    return this.items.length
  }

  get isEmpty(): boolean {
    return this.items.length === 0
  }

  get isBusy(): boolean {
    return this.isProcessing
  }

  peek(): T | undefined {
    return this.items[0]
  }

  get 0(): T | undefined {
    return this.items[0]
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this.items[Symbol.iterator]()
  }

  push(...items: T[]): void {
    if (items.length === 0) return
    this.items.push(...items)
    void this.drain()
  }

  unshift(...items: T[]): void {
    if (items.length === 0) return
    if (this.isCurrentItemRunning) {
      // If the head item is actively being processed, keep it at index 0 and insert new items right behind it
      this.items.splice(1, 0, ...items)
    } else {
      this.items.unshift(...items)
    }
    void this.drain()
  }

  clear(): void {
    this.items = []
    if (!this.isProcessing) {
      this.resolveIdleWaiters()
    }
  }

  shift(): T | undefined {
    return this.items.shift()
  }

  async whenIdle(): Promise<void> {
    if (!this.isProcessing && this.items.length === 0) {
      return
    }
    return new Promise<void>(resolve => {
      this.idleResolvers.push(resolve)
    })
  }

  private resolveIdleWaiters(): void {
    if (this.idleResolvers.length > 0) {
      const resolvers = [...this.idleResolvers]
      this.idleResolvers = []
      for (const resolve of resolvers) {
        resolve()
      }
    }
  }

  private async drain(): Promise<void> {
    if (this.isProcessing) {
      return
    }
    this.isProcessing = true

    try {
      while (this.items.length > 0) {
        const item = this.items[0]
        this.isCurrentItemRunning = true

        try {
          await this.worker(item)
        } catch (err) {
          if (this.options?.onError) {
            this.options.onError(err, item)
          } else {
            console.error('[AsyncQueue] Unhandled error in queue worker:', err)
          }
        } finally {
          this.isCurrentItemRunning = false
          if (this.items.length > 0 && this.items[0] === item) {
            this.items.shift()
          }
        }
      }
    } finally {
      this.isProcessing = false
      if (this.items.length > 0) {
        void this.drain()
      } else {
        this.resolveIdleWaiters()
      }
    }
  }
}
