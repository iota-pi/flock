import type { ItemId } from '@vault/shared'
import type { VaultMetadata } from '../shared/types'
import type { ManifestAsk, ManifestAskOptions } from './ManifestSyncManager'

/**
 * The events a component raises for one built after it. Components are built in the order data flows
 * through them, so these are the only links that point back up that order.
 */
export interface SyncSignalHandlers {
  /** Local work waits for a poll, such as a new pending mark or a gap to heal */
  workDue: () => void
  /** When the next snapshot upload is due has changed */
  snapshotDue: () => void
  /** Runs a poll now, or right after the one in flight, resolving once it has finished */
  pollNow: () => Promise<void>
  /** The user is active in the tab, or changes came from another device */
  activity: () => void
  /** An item was edited */
  edited: (itemId: ItemId) => void
  /** An item's doc holds changes a snapshot merged into it lacks, so they still have to be pushed */
  localChangesFound: (itemId: ItemId) => void
  /** An item's doc has no data in local storage, so only its snapshot can restore it */
  localDataMissing: (itemId: ItemId) => void
  /** The account's metadata changed */
  metadataUpdated: (metadata: VaultMetadata) => void
  /** Asks the poll's manifest phase for a sync (`ManifestSyncManager.ask`) */
  askManifest: (options: ManifestAskOptions) => ManifestAsk
}

/**
 * Carries the events in `SyncSignalHandlers` to their handlers, which are bound once every component
 * exists. Components are built synchronously and bound in the same call, so a signal raised before
 * then is a wiring bug, and it throws rather than being dropped.
 */
export class SyncSignals {
  private handlers: SyncSignalHandlers | null = null

  bind(handlers: SyncSignalHandlers): void {
    if (this.handlers) {
      throw new Error('Sync signals are already bound')
    }
    this.handlers = handlers
  }

  /** The bound handlers, to raise a signal through */
  get raise(): SyncSignalHandlers {
    if (!this.handlers) {
      throw new Error('A sync signal was raised before its handlers were bound')
    }
    return this.handlers
  }
}
