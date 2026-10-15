import { runStorageOperation } from '../utils/storageManager'
import { getSyncMetadataStorage, SYNC_METADATA_KEYS } from './stores/syncMetadataStorage'
import type { DataVersionStatus, MigrationRequiredReason } from '../shared/types'

/** Thrown when sync can't start until the app's migration app has run */
export class MigrationRequiredError extends Error {
  constructor(readonly reason: MigrationRequiredReason) {
    super(reason === 'device'
      ? "This device's local data needs migrating before sync can start"
      : "This account's data needs migrating before sync can start")
    this.name = 'MigrationRequiredError'
  }
}

/** The data version this device's local data has been migrated to (0 when it was never recorded) */
export async function readDeviceDataVersion(accountId: string): Promise<number> {
  const stored = await getSyncMetadataStorage(accountId).getItem<number>(SYNC_METADATA_KEYS.DEVICE_DATA_VERSION)
  return typeof stored === 'number' ? stored : 0
}

export interface DataVersionTrackerDeps {
  accountId: string
  /** The app's current data version (`SyncDomain.dataVersion`). 0 disables tracking. */
  dataVersion: number
  /** Asks the server to raise the account's data version (`accounts.raiseDataVersion`) */
  raiseAccountDataVersion: () => Promise<{ dataVersion: number, blockers: string[] }>
}

/**
 * Records how far migration has got, so that devices and accounts left behind can later be sent to
 * a separate migration app (see "Backwards compatibility" in docs/vault-extraction.md).
 *
 * - The device level is written to the account's sync metadata once a manifest sync finishes
 *   without failures. By then the session has run every local migration: the app's
 *   `migrateLocalData` hook before any store was read, and legacy settings during the sync. A device with no
 *   local data starts at the current version.
 * - The account level is raised by the server, which checks the account's stored data first. The
 *   leader asks once per session, after this device has rewritten its snapshots.
 */
export class DataVersionTracker {
  private hasAskedServer = false

  constructor(private readonly deps: DataVersionTrackerDeps) {}

  /** Call at startup, with whether this device holds any local data for the account yet */
  async onStart(hasLocalData: boolean): Promise<void> {
    if (!hasLocalData) {
      await this.recordDeviceVersion()
    }
  }

  async onSyncedWithoutFailures(): Promise<void> {
    await this.recordDeviceVersion()
  }

  /** Reads the device level and asks the server to raise the account level, reporting both */
  async checkStatus(): Promise<DataVersionStatus> {
    const device = await readDeviceDataVersion(this.deps.accountId)
    const { dataVersion, blockers } = await this.deps.raiseAccountDataVersion()
    return { device, account: dataVersion, blockers }
  }

  async onSnapshotsUpgraded(): Promise<void> {
    if (this.deps.dataVersion === 0 || this.hasAskedServer) return
    this.hasAskedServer = true
    const { dataVersion, blockers } = await this.deps.raiseAccountDataVersion()
    if (blockers.length > 0) {
      console.info(`[DataVersionTracker] Account data is at version ${dataVersion}; still to migrate: ${blockers.join(', ')}`)
    }
  }

  private async recordDeviceVersion(): Promise<void> {
    const { accountId, dataVersion } = this.deps
    if (dataVersion === 0 || await readDeviceDataVersion(accountId) >= dataVersion) return
    const storage = getSyncMetadataStorage(accountId)
    await runStorageOperation(() => storage.setItem(SYNC_METADATA_KEYS.DEVICE_DATA_VERSION, dataVersion))
  }
}
