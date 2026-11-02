/**
 * A FIFO queue that evicts its oldest item when a push would exceed its capacity.
 */
export class BoundedQueue<T> implements Iterable<T> {
  private readonly items: T[] = []

  constructor(
    private readonly maxCapacity: number,
    private readonly onEvict?: (item: T) => void,
  ) {
    if (maxCapacity <= 0 || !Number.isFinite(maxCapacity)) {
      throw new RangeError(`BoundedQueue maxCapacity must be a positive finite number, got ${maxCapacity}`)
    }
  }

  get length(): number {
    return this.items.length
  }

  push(item: T): void {
    if (this.items.length >= this.maxCapacity) {
      this.onEvict?.(this.items.shift()!)
    }
    this.items.push(item)
  }

  shift(): T | undefined {
    return this.items.shift()
  }

  clear(): void {
    this.items.length = 0
  }

  /** Keeps only the items that satisfy `predicate`, in place. */
  filterInPlace(predicate: (item: T) => boolean): void {
    let writeIndex = 0
    for (const item of this.items) {
      if (predicate(item)) {
        this.items[writeIndex] = item
        writeIndex += 1
      }
    }
    this.items.length = writeIndex
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this.items[Symbol.iterator]()
  }
}
