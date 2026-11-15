import {
  announceVaultLocked,
  announceVaultRemoved,
  clearVaultDeviceData,
  lockVaultKeys,
  readStoredMetadata,
} from '@vault/client'
import { createLogger } from 'src/utils/logger'
import { clearMigrationDeferral } from '../../migrate/detection'
import { useAppStore } from '../../state/store'
import { unsubscribe as unsubscribeFromNotifications } from '../../utils/pushNotifications'
import { markManualLock } from './autoLockStore'
import { clearBackupReminder } from './backupReminderStore'
import { SyncBridge } from './syncBridge'

const log = createLogger('session')

export async function loadAccount() {
  const { updateAuth } = useAppStore.getState()
  const stored = readStoredMetadata()
  if (stored?.account) {
    updateAuth({ account: stored.account, initializing: false })
  } else {
    updateAuth({ initializing: false })
  }
}

export async function lockVault() {
  const { updateAuth } = useAppStore.getState()
  await lockVaultKeys()

  await SyncBridge.shutdown({ clearLocalData: false })

  updateAuth({ loggedIn: false })
}

/**
 * Locks this tab and every other tab open on the account, as the user's lock button does. Locks that
 * only concern this tab (auto-lock when idle) use `lockVault`.
 */
export async function lockVaultEverywhere() {
  const { account } = useAppStore.getState()
  markManualLock()
  if (account) {
    announceVaultLocked(account)
  }
  await lockVault()
}

/** Locks this tab because the user locked the account in another one */
export async function handleVaultLockedElsewhere(account: string) {
  const state = useAppStore.getState()
  if (!state.loggedIn || state.account !== account) return
  markManualLock()
  await lockVault()
  state.setMessage({ severity: 'info', message: 'Flock was locked in another tab' })
}

/** Locks this tab and forgets the account because another tab is removing it from this device */
export async function handleVaultRemovedElsewhere(account: string) {
  const state = useAppStore.getState()
  if (state.account !== account) return
  if (state.loggedIn) {
    try {
      await lockVault()
    } catch (error) {
      log.error('Failed to lock for a removal in another tab', error)
    }
  }
  state.updateAuth({ account: '', loggedIn: false })
  state.setMessage({ severity: 'info', message: 'Your account was removed from this device in another tab' })
}

/** Some of the account's data could not be removed from this device */
export class LocalDataRemovalError extends Error {
  constructor(readonly causes: unknown[]) {
    super('Some local data could not be removed from this device')
    this.name = 'LocalDataRemovalError'
  }
}

/**
 * Signs out, locks every other tab and deletes the account's data from this device. It always signs
 * out, and carries on past failures so it removes as much as it can, then throws
 * `LocalDataRemovalError` if anything was left behind. Pass `accountDeleted` once the server no longer
 * has the account, so that it makes no more requests for it.
 */
export async function removeVaultFromDevice({ accountDeleted = false } = {}) {
  const { account, updateAuth } = useAppStore.getState()
  const failures: unknown[] = []

  if (account) {
    // Before shutting down, so the other tabs' database connections close in time for the deletion
    announceVaultRemoved(account)
    SyncBridge.requestClearOnShutdown?.(account)
  }

  try {
    await SyncBridge.shutdown({ clearLocalData: true, accountId: account })
  } catch (error) {
    log.error('Failed to clear local sync data', error)
    failures.push(error)
  }

  if (account) {
    try {
      await unsubscribeFromNotifications(account, { serverGone: accountDeleted })
    } catch (error) {
      log.error('Failed to unsubscribe from notifications', error)
    }
  }
  try {
    await clearVaultDeviceData(account || undefined)
  } catch (error) {
    log.error('Failed to clear vault device data', error)
    failures.push(error)
  }
  if (account) {
    clearBackupReminder(account)
    clearMigrationDeferral(account)
  }
  updateAuth({ account: '', loggedIn: false })

  if (failures.length > 0) {
    throw new LocalDataRemovalError(failures)
  }
}
