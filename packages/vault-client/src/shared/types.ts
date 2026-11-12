import type { ItemId } from '@vault/shared'

/**
 * A synced document as the vault sees it. Apps describe their own document shape with a DocCodec;
 * the vault itself only relies on `id` and the `deleted` tombstone flag.
 */
export type VaultDoc = {
  id: ItemId
  deleted?: boolean
  [key: string]: unknown
}

/** Account-level settings stored with the local item index */
export type VaultMetadata = Record<string, unknown>

export type SyncStatus = 'idle' | 'connecting' | 'syncing' | 'offline' | 'degraded' | 'dead'

/** Local changes on this device that the server doesn't have yet, which clearing local data would lose */
export interface UnsyncedChanges {
  /** Items with changes not yet pushed or a snapshot not yet uploaded */
  pendingItems: number
  /** Items held for manual recovery, whose local changes aren't syncing (not counted in `pendingItems`) */
  quarantinedItems: number
}

/**
 * What holds up an item's changes: first start waiting for the server's copy (`awaitingHeads`) or
 * for this device's own snapshot (`awaitingSnapshot`), a change only a snapshot can deliver
 * (`snapshotOnly`), a doc this device can't load (`unloadable`), or nothing known (`unknown`)
 */
export type StuckReason = 'awaitingHeads' | 'awaitingSnapshot' | 'snapshotOnly' | 'unloadable' | 'unknown'

/** Counts of stuck items by reason. A reason with none is absent. */
export type StuckItems = Partial<Record<StuckReason, number>>

/** The changes waiting to be pushed, as `SyncProgress` reports them */
export interface UnpushedChanges extends UnsyncedChanges {
  /** Items with changes not yet pushed. Unlike `UnsyncedChanges`, a snapshot still to upload doesn't count. */
  pendingItems: number
  /**
   * Of `pendingItems`, those that have waited longer than `SYNC_TIMEOUTS.stuckPendingAge`, by what
   * holds them up. Absent when there are none.
   */
  stuckItems?: StuckItems
}

/** How far this device's changes have reached the server, as the worker's `syncProgress` events report it */
export interface SyncProgress extends UnpushedChanges {
  /** When any of the account's tabs on this device last completed a sync with the server, or null if none has */
  lastSyncedAt: number | null
}

/**
 * Why sync can't run until the app's migration app has run (see `SyncWorkerConfig.minDataVersion`):
 * this device's local data is below the minimum level, or the server holds rows in a legacy format.
 */
export type MigrationRequiredReason = 'device' | 'account'

/** How far migration has got, as reported by `SyncApi.checkDataVersion` */
export interface DataVersionStatus {
  /** The level this device's local data has been migrated to */
  device: number
  /** The account's level, as the server reports it after checking the account's data */
  account: number
  /** What still holds the account below the app's current level */
  blockers: string[]
  /** How many live items each item-level blocker still covers, when the server says */
  blockedItems?: Record<string, number>
}

/** The items re-encrypted under the active data key, and those that couldn't be */
export interface ReencryptResult {
  succeeded: ItemId[]
  failed: Array<{ itemId: ItemId; error: string }>
}

/**
 * What a re-encryption is doing: waiting for this tab to lead (only the leader pushes), waiting for
 * first start to allow pushes, or rewriting snapshots
 */
export type ReencryptStage = 'waitingForLeader' | 'waitingForSync' | 'reencrypting'

/** Options for a re-encryption run, or for preparing one */
export interface ReencryptOptions {
  /**
   * How long to wait for leadership and for first start before giving up with a
   * `ReencryptionWaitError`. Without it, a run waits as long as it takes.
   */
  waitTimeoutMs?: number
}

/** Options for a re-encryption called from the main thread */
export interface ReencryptCallOptions extends ReencryptOptions {
  /** Called whenever the run's stage changes, and with null once it stops */
  onStage?: (stage: ReencryptStage | null) => void
  /** Aborting it stops the run in the worker (and any retry it scheduled), and rejects the call */
  signal?: AbortSignal
}

/** What the worker's session is waiting on, for a migration app to report when it stalls */
export interface SyncDiagnostics {
  isLeader: boolean
  isOnline: boolean
  /** Whether first start's network part has finished on this device */
  firstStartSynced: boolean
  /** Whether first start lets pushes go ahead (its manifest sync has run) */
  firstStartReadyToPush: boolean
  /** Why first start's network part last failed, or null */
  firstStartError: string | null
  /** The stage of the re-encryption running now, or null */
  reencryptStage: ReencryptStage | null
}
