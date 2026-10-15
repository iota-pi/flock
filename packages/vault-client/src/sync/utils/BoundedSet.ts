export interface BoundedSetOptions<T> {
  initialItems?: Iterable<T>
  onEvict?: (value: T) => void
}

/**
 * A FIFO bounded Set that maintains insertion order and evicts the oldest
 * elements when capacity is exceeded.
 */
export class BoundedSet<T> implements Iterable<T> {
  private readonly set = new Set<T>()
  private readonly _maxCapacity: number
  private readonly onEvict?: (value: T) => void

  constructor(
    maxCapacity: number,
    optionsOrInitial?: BoundedSetOptions<T> | Iterable<T> | ((value: T) => void),
    onEvict?: (value: T) => void
  ) {
    if (maxCapacity <= 0 || !Number.isFinite(maxCapacity)) {
      throw new RangeError(`BoundedSet maxCapacity must be a positive finite number, got ${maxCapacity}`)
    }
    this._maxCapacity = Math.floor(maxCapacity)

    if (typeof optionsOrInitial === 'function') {
      this.onEvict = optionsOrInitial
    } else if (optionsOrInitial && typeof (optionsOrInitial as Iterable<T>)[Symbol.iterator] === 'function') {
      this.onEvict = onEvict
      for (const item of optionsOrInitial as Iterable<T>) {
        this.add(item)
      }
    } else if (optionsOrInitial) {
      const opts = optionsOrInitial as BoundedSetOptions<T>
      this.onEvict = opts.onEvict ?? onEvict
      if (opts.initialItems) {
        for (const item of opts.initialItems) {
          this.add(item)
        }
      }
    } else {
      this.onEvict = onEvict
    }
  }

  get size(): number {
    return this.set.size
  }

  get maxCapacity(): number {
    return this._maxCapacity
  }

  /**
   * Adds an element to the set. If the element is new and adding it would exceed
   * maxCapacity, the oldest element is evicted in FIFO order.
   * If the element already exists, existing insertion order is retained without eviction.
   */
  add(value: T): this {
    if (this.set.has(value)) {
      return this
    }

    if (this.set.size >= this._maxCapacity) {
      const oldest = this.set.values().next().value
      if (oldest !== undefined) {
        this.set.delete(oldest)
        this.onEvict?.(oldest)
      }
    }

    this.set.add(value)
    return this
  }

  has(value: T): boolean {
    return this.set.has(value)
  }

  delete(value: T): boolean {
    return this.set.delete(value)
  }

  clear(): void {
    this.set.clear()
  }

  keys(): IterableIterator<T> {
    return this.set.keys()
  }

  values(): IterableIterator<T> {
    return this.set.values()
  }

  entries(): IterableIterator<[T, T]> {
    return this.set.entries()
  }

  forEach(callbackfn: (value: T, value2: T, set: BoundedSet<T>) => void, thisArg?: unknown): void {
    for (const val of this.set) {
      callbackfn.call(thisArg, val, val, this)
    }
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this.set[Symbol.iterator]()
  }
}
