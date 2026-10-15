export interface WalEntryDescriptor {
  id: string
  itemId?: string
  createdAt?: number
  seq?: number
}

/**
 * Query abstraction over a collection of WAL entries that encapsulates
 * in-flight filtering and entry status queries (available, superseded, valid).
 */
export class WalEntryQuery<T extends WalEntryDescriptor> {
  constructor(
    private readonly entries: readonly T[],
    private readonly inFlightIds: ReadonlySet<string> = new Set()
  ) {}

  /**
   * Total number of entries in the queried set.
   */
  get totalCount(): number {
    return this.entries.length
  }

  /**
   * Returns all entries that are not currently marked in-flight.
   */
  available(): T[] {
    if (this.inFlightIds.size === 0) {
      return [...this.entries]
    }
    return this.entries.filter(e => !this.inFlightIds.has(e.id))
  }

  /**
   * Returns all entries that are currently marked in-flight.
   */
  inFlight(): T[] {
    if (this.inFlightIds.size === 0) {
      return []
    }
    return this.entries.filter(e => this.inFlightIds.has(e.id))
  }

  /**
   * Returns available (not in-flight) entries whose IDs exist in the superseded set.
   */
  superseded(supersededIds: ReadonlySet<string>): T[] {
    return this.available().filter(e => supersededIds.has(e.id))
  }

  /**
   * Returns available (not in-flight) entries whose IDs do NOT exist in the superseded set.
   */
  valid(supersededIds: ReadonlySet<string>): T[] {
    return this.available().filter(e => !supersededIds.has(e.id))
  }

  /**
   * Returns valid (not superseded, not in-flight) entries sorted chronologically
   * by `createdAt` ascending, with `seq` ascending as tiebreaker.
   */
  validSorted(supersededIds: ReadonlySet<string>): T[] {
    return WalEntryQuery.sortByAge(this.valid(supersededIds))
  }

  /**
   * Returns a set of unique item IDs that currently have at least one entry in-flight.
   */
  inFlightItemIds(): Set<string> {
    const itemIds = new Set<string>()
    for (const entry of this.inFlight()) {
      if (typeof entry.itemId === 'string' && entry.itemId.length > 0) {
        itemIds.add(entry.itemId)
      }
    }
    return itemIds
  }

  /**
   * Returns valid (not superseded, not in-flight) entries whose items do NOT have
   * any in-flight entries, sorted chronologically.
   * This ensures that items with active pushes are completely excluded from pruning,
   * preventing torn/partial WAL histories.
   */
  prunableSorted(supersededIds: ReadonlySet<string>): T[] {
    const inFlightItems = this.inFlightItemIds()
    if (inFlightItems.size === 0) {
      return this.validSorted(supersededIds)
    }
    return this.validSorted(supersededIds).filter(
      e => !e.itemId || !inFlightItems.has(e.itemId)
    )
  }

  /**
   * Returns available (not in-flight) entries sorted chronologically
   * by `createdAt` ascending, with `seq` ascending as tiebreaker.
   */
  availableSorted(): T[] {
    return WalEntryQuery.sortByAge(this.available())
  }

  /**
   * Sorts entries chronologically by `createdAt` ascending, with `seq` ascending as tiebreaker.
   * Returns a new array without mutating the input.
   */
  static sortByAge<E extends WalEntryDescriptor>(entries: readonly E[]): E[] {
    return [...entries].sort(
      (a, b) => ((a.createdAt ?? 0) - (b.createdAt ?? 0)) || ((a.seq ?? 0) - (b.seq ?? 0))
    )
  }
}
