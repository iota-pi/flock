import { fireAndForget } from '../utils/fireAndForget'
import { runStorageOperation } from '../utils/storageManager'
import { getSyncMetadataStorage, SYNC_METADATA_KEYS } from './stores/syncMetadataStorage'

export interface SnapshotFormatUpgradeDeps {
  accountId: string
  /** Re-encrypts and uploads the snapshot of every item */
  rewriteSnapshots: (signal: AbortSignal) => Promise<{ failed: unknown[] }>
  /** Called once this device's snapshots are all bound, whether rewritten now or in an earlier session */
  onUpgraded?: () => void
}

/**
 * Rewrites every snapshot once per device, so that snapshots written before ciphertexts were bound
 * to their document get replaced with bound ones.
 *
 * It starts once both a manifest sync has finished without failures (so local docs include
 * everything in the server's snapshots) and this tab is the leader (snapshot uploads belong to the
 * leader), in either order. A device that has finished the rewrite skips it, and an incomplete
 * rewrite is retried next session rather than on every sync.
 */
export class SnapshotFormatUpgrade {
  private hasSynced = false
  private isLeader = false
  private hasStarted = false
  private readonly abortController = new AbortController()

  constructor(private readonly deps: SnapshotFormatUpgradeDeps) {}

  /** Call after a manifest sync in which every item hydrated */
  onSyncedWithoutFailures(): void {
    this.hasSynced = true
    this.startIfReady()
  }

  onLeaderChange(isLeader: boolean): void {
    this.isLeader = isLeader
    this.startIfReady()
  }

  stop(): void {
    this.abortController.abort()
  }

  private startIfReady(): void {
    if (this.hasStarted || !this.hasSynced || !this.isLeader) return
    this.hasStarted = true
    fireAndForget(this.run(), 'SnapshotFormatUpgrade:run')
  }

  private async run(): Promise<void> {
    const { signal } = this.abortController
    const storage = getSyncMetadataStorage(this.deps.accountId)
    if (await storage.getItem<boolean>(SYNC_METADATA_KEYS.SNAPSHOTS_DOC_BOUND)) {
      this.deps.onUpgraded?.()
      return
    }
    if (signal.aborted) return

    const { failed } = await this.deps.rewriteSnapshots(signal)
    if (signal.aborted) return
    if (failed.length > 0) {
      console.warn(`[SnapshotFormatUpgrade] ${failed.length} snapshots were not rewritten (will retry next session)`)
      return
    }

    await runStorageOperation(() => storage.setItem(SYNC_METADATA_KEYS.SNAPSHOTS_DOC_BOUND, true))
    this.deps.onUpgraded?.()
  }
}
