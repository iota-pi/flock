export interface BoundedMapOptions<K, V> {
  initialEntries?: Iterable<readonly [K, V]>
  onEvict?: (key: K, value: V) => void
}

/**
 * A FIFO bounded Map that maintains insertion order and evicts the oldest
 * entries when capacity is exceeded.
 */
export class BoundedMap<K, V> implements Iterable<[K, V]> {
  private readonly map = new Map<K, V>()
  private readonly _maxCapacity: number
  private readonly onEvict?: (key: K, value: V) => void

  constructor(
    maxCapacity: number,
    optionsOrInitial?: BoundedMapOptions<K, V> | Iterable<readonly [K, V]> | ((key: K, value: V) => void),
    onEvict?: (key: K, value: V) => void
  ) {
    if (maxCapacity <= 0 || !Number.isFinite(maxCapacity)) {
      throw new RangeError(`BoundedMap maxCapacity must be a positive finite number, got ${maxCapacity}`)
    }
    this._maxCapacity = Math.floor(maxCapacity)

    if (typeof optionsOrInitial === 'function') {
      this.onEvict = optionsOrInitial
    } else if (optionsOrInitial && typeof (optionsOrInitial as Iterable<readonly [K, V]>)[Symbol.iterator] === 'function') {
      this.onEvict = onEvict
      for (const [key, value] of optionsOrInitial as Iterable<readonly [K, V]>) {
        this.set(key, value)
      }
    } else if (optionsOrInitial) {
      const opts = optionsOrInitial as BoundedMapOptions<K, V>
      this.onEvict = opts.onEvict ?? onEvict
      if (opts.initialEntries) {
        for (const [key, value] of opts.initialEntries) {
          this.set(key, value)
        }
      }
    } else {
      this.onEvict = onEvict
    }
  }

  get size(): number {
    return this.map.size
  }

  get maxCapacity(): number {
    return this._maxCapacity
  }

  /**
   * Sets the value for the key in the map.
   * If the key is new and setting it would exceed maxCapacity, the oldest
   * entry is evicted in FIFO order.
   * If the key already exists, updates its value in-place without changing key insertion order.
   */
  set(key: K, value: V): this {
    if (this.map.has(key)) {
      this.map.set(key, value)
      return this
    }

    if (this.map.size >= this._maxCapacity) {
      const oldestEntry = this.map.entries().next().value
      if (oldestEntry) {
        const [oldestKey, oldestValue] = oldestEntry
        this.map.delete(oldestKey)
        this.onEvict?.(oldestKey, oldestValue)
      }
    }

    this.map.set(key, value)
    return this
  }

  get(key: K): V | undefined {
    return this.map.get(key)
  }

  has(key: K): boolean {
    return this.map.has(key)
  }

  delete(key: K): boolean {
    return this.map.delete(key)
  }

  clear(): void {
    this.map.clear()
  }

  keys(): IterableIterator<K> {
    return this.map.keys()
  }

  values(): IterableIterator<V> {
    return this.map.values()
  }

  entries(): IterableIterator<[K, V]> {
    return this.map.entries()
  }

  forEach(callbackfn: (value: V, key: K, map: BoundedMap<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.map) {
      callbackfn.call(thisArg, value, key, this)
    }
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.map[Symbol.iterator]()
  }
}
