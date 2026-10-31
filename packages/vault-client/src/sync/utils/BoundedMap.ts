/**
 * A Map that evicts its oldest entry (by first insertion) when adding a new
 * key would exceed its capacity. Updating an existing key keeps its position.
 */
export class BoundedMap<K, V> extends Map<K, V> {
  constructor(private readonly maxCapacity: number) {
    super()
  }

  override set(key: K, value: V): this {
    if (!this.has(key) && this.size >= this.maxCapacity) {
      this.delete(this.keys().next().value!)
    }
    return super.set(key, value)
  }
}
