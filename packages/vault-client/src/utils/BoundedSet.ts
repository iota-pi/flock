/**
 * A Set that evicts its oldest value (by first insertion) when adding a new
 * value would exceed its capacity.
 */
export class BoundedSet<T> extends Set<T> {
  constructor(private readonly maxCapacity: number) {
    super()
  }

  override add(value: T): this {
    if (!this.has(value) && this.size >= this.maxCapacity) {
      this.delete(this.values().next().value!)
    }
    return super.add(value)
  }
}
