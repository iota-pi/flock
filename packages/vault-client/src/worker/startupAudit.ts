import type { ItemId } from '@vault/shared'
import type { RecoveryManager } from './RecoveryManager'
import type { SnapshotSchedule } from './SnapshotSchedule'
import type { SyncSessionState } from './SyncSessionState'
import { checkAlive, isAbortError } from '../utils/abort'
import { createLogger } from '../utils/logger'

const log = createLogger('startupAudit')

export interface StartupAuditDeps {
  recoveryManager: Pick<RecoveryManager, 'listRecoveryItems'>
  schedule: Pick<SnapshotSchedule, 'queueRestored'>
  session: Pick<SyncSessionState, 'isShutdown'>
}

/**
 * The startup audit, run once the item records have loaded with the items they flag
 * (`ItemSyncState.load`): queues every flagged item that isn't quarantined. A quarantine that can't
 * be read quarantines nothing, so every flagged item goes up.
 */
export async function queueFlaggedItems(flagged: readonly ItemId[], deps: StartupAuditDeps): Promise<void> {
  if (flagged.length === 0 || deps.session.isShutdown) return
  const isAlive = () => !deps.session.isShutdown
  try {
    const quarantined = new Set<ItemId>()
    try {
      const entries = await deps.recoveryManager.listRecoveryItems()
      checkAlive(null, isAlive)
      for (const entry of entries) {
        quarantined.add(entry.itemId)
      }
    } catch (recoveryErr) {
      if (isAbortError(recoveryErr)) throw recoveryErr
      log.error('Failed to read manual recovery entries during startup audit', recoveryErr)
    }
    deps.schedule.queueRestored(flagged.filter(itemId => !quarantined.has(itemId)))
  } catch (error) {
    if (isAbortError(error) || !isAlive()) return
    log.error('Failed to restore flagged items', error)
  }
}
