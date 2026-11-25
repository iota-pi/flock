/**
 * A manifest sync another component needs, such as the log puller catching up or recovering lost
 * rows. It stays asked for until a sync fetches the manifest (rule 4), and any sync that does meets
 * every demand placed before it started.
 */
export interface ManifestDemand {
  /** What the sync is for, which the error names when it can't run */
  readonly purpose: string
  /** Whether the poll runs it before reading the log, rather than after */
  readonly beforeRead: boolean
  /** Called once a sync has fetched the manifest and met the demand */
  readonly onFetched?: () => void
}

/**
 * The manifest syncs demanded and not yet met. The log puller places demands and
 * `ManifestSyncManager` meets them, so this sits between the two and is built before either.
 */
export class ManifestDemands {
  private readonly placed = new Set<ManifestDemand>()

  /**
   * Asks for a sync at the next manifest phase of the demand's stage, which stays asked for until a
   * sync fetches the manifest. Placing a demand that is already placed does nothing.
   */
  demand(demand: ManifestDemand): void {
    this.placed.add(demand)
  }

  /** Whether a demand is waiting for a sync to fetch the manifest */
  isDemanded(demand: ManifestDemand): boolean {
    return this.placed.has(demand)
  }

  get size(): number {
    return this.placed.size
  }

  /** The demands waiting, in the order they were placed */
  list(): ManifestDemand[] {
    return Array.from(this.placed)
  }

  /** Withdraws a demand once a sync has met it, and tells whoever placed it */
  meet(demand: ManifestDemand): void {
    this.placed.delete(demand)
    demand.onFetched?.()
  }
}
