export interface BoundedQueueOptions<T> {
  initialItems?: Iterable<T>
  onEvict?: (item: T) => void
  onEvictBatch?: (items: T[]) => void
}

/**
 * A FIFO bounded queue that automatically evicts the oldest items when
 * its capacity limit is exceeded.
 */
export class BoundedQueue<T> implements Iterable<T> {
  private readonly items: T[] = []
  private readonly _maxCapacity: number
  private readonly onEvict?: (item: T) => void
  private readonly onEvictBatch?: (items: T[]) => void

  constructor(
    maxCapacity: number,
    options?: BoundedQueueOptions<T> | ((item: T) => void)
  ) {
    if (maxCapacity <= 0 || !Number.isFinite(maxCapacity)) {
      throw new RangeError(`BoundedQueue maxCapacity must be a positive finite number, got ${maxCapacity}`)
    }
    this._maxCapacity = Math.floor(maxCapacity)

    if (typeof options === 'function') {
      this.onEvict = options
    } else if (options) {
      this.onEvict = options.onEvict
      this.onEvictBatch = options.onEvictBatch
      if (options.initialItems) {
        this.push(...options.initialItems)
      }
    }
  }

  get length(): number {
    return this.items.length
  }

  get size(): number {
    return this.items.length
  }

  get maxCapacity(): number {
    return this._maxCapacity
  }

  /**
   * Appends items to the end of the queue. If pushing causes the queue length
   * to exceed maxCapacity, the oldest items are evicted from the front in FIFO order.
   * Returns the new length of the queue.
   */
  push(...newItems: T[]): number {
    if (newItems.length === 0) {
      return this.items.length
    }

    if (newItems.length === 1) {
      if (this.items.length >= this._maxCapacity) {
        const evicted = this.items.shift()!
        this.onEvict?.(evicted)
        this.onEvictBatch?.([evicted])
      }
      this.items.push(newItems[0])
      return this.items.length
    }

    const total = this.items.length + newItems.length
    if (total > this._maxCapacity) {
      const overflow = total - this._maxCapacity
      const evicted: T[] = []

      if (overflow <= this.items.length) {
        const removedFromCurrent = this.items.splice(0, overflow)
        evicted.push(...removedFromCurrent)
        this.items.push(...newItems)
      } else {
        const removedFromCurrent = this.items.splice(0, this.items.length)
        const overflowFromNew = overflow - removedFromCurrent.length
        const removedFromNew = newItems.slice(0, overflowFromNew)
        const remainingNew = newItems.slice(overflowFromNew)
        evicted.push(...removedFromCurrent, ...removedFromNew)
        this.items.push(...remainingNew)
      }

      if (this.onEvict) {
        for (const item of evicted) {
          this.onEvict(item)
        }
      }
      this.onEvictBatch?.(evicted)
    } else {
      this.items.push(...newItems)
    }

    return this.items.length
  }

  /**
   * Removes and returns the first (oldest) item from the queue, or undefined if empty.
   */
  shift(): T | undefined {
    return this.items.shift()
  }

  /**
   * Returns the first (oldest) item from the queue without removing it.
   */
  peek(): T | undefined {
    return this.items[0]
  }

  /**
   * Returns the last (newest) item from the queue without removing it.
   */
  peekLast(): T | undefined {
    return this.items[this.items.length - 1]
  }

  /**
   * Clears all items from the queue.
   */
  clear(): void {
    this.items.length = 0
  }

  /**
   * Removes and returns all items currently in the queue as an array.
   */
  drain(): T[] {
    const drained = this.items.slice()
    this.items.length = 0
    return drained
  }

  /**
   * Returns a shallow copy of the queue items as an array.
   */
  toArray(): T[] {
    return this.items.slice()
  }

  /**
   * Returns a new BoundedQueue containing items that satisfy the predicate,
   * retaining the same maxCapacity and eviction callbacks.
   */
  filter(predicate: (item: T, index: number) => boolean): BoundedQueue<T> {
    const filtered = this.items.filter(predicate)
    return new BoundedQueue<T>(this._maxCapacity, {
      initialItems: filtered,
      onEvict: this.onEvict,
      onEvictBatch: this.onEvictBatch,
    })
  }

  /**
   * Mutates the queue in-place, retaining only the items that satisfy the predicate.
   * Returns this instance.
   */
  filterInPlace(predicate: (item: T, index: number) => boolean): this {
    let writeIdx = 0
    for (let i = 0; i < this.items.length; i++) {
      if (predicate(this.items[i], i)) {
        if (writeIdx !== i) {
          this.items[writeIdx] = this.items[i]
        }
        writeIdx += 1
      }
    }
    this.items.length = writeIdx
    return this
  }

  map<U>(fn: (item: T, index: number) => U): U[] {
    return this.items.map(fn)
  }

  forEach(fn: (item: T, index: number) => void): void {
    this.items.forEach(fn)
  }

  some(predicate: (item: T, index: number) => boolean): boolean {
    return this.items.some(predicate)
  }

  every(predicate: (item: T, index: number) => boolean): boolean {
    return this.items.every(predicate)
  }

  find(predicate: (item: T, index: number) => boolean): T | undefined {
    return this.items.find(predicate)
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this.items[Symbol.iterator]()
  }
}
