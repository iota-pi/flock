import { confirmAccountPassword, deleteAccountItems, deleteAccountRecord } from '@vault/client'
import type { AlertColor } from '@mui/material/Alert'
import { SyncBridge } from './syncBridge'

/**
 * Deleting an account takes four steps, which the delete account dialog runs one at a time so that
 * it can tell the user about each failure and let them retry or carry on:
 *
 * 1. `startAccountDeletion` checks the password and stops sync on this device, so that it can't push
 *    anything back up once the server's copy is gone. A wrong password stops here with nothing done.
 * 2. `deleteServerData` deletes every item and log row from the server. The server first stops the
 *    account logging in and ends its other sessions, so no other device can sync them back up.
 * 3. `deleteServerAccount` deletes the account record.
 * 4. `removeVaultFromDevice` (session.ts) removes the account from this device, as signing out does.
 */
export async function startAccountDeletion(account: string, password: string): Promise<string> {
  const authToken = await confirmAccountPassword(account, password)
  await SyncBridge.shutdown({ clearLocalData: false })
  return authToken
}

export async function deleteServerData(account: string, authToken: string): Promise<void> {
  await deleteAccountItems({ account, currentAuthToken: authToken })
}

export async function deleteServerAccount(account: string, authToken: string): Promise<void> {
  await deleteAccountRecord({ account, currentAuthToken: authToken })
}

/** What was left behind, for the message shown once the dialog has closed */
export interface DeletionOutcome {
  itemsLeft: boolean
  accountLeft: boolean
  localFailed: boolean
}

export function describeDeletionOutcome({ itemsLeft, accountLeft, localFailed }: DeletionOutcome): {
  severity: AlertColor,
  message: string,
} {
  let message: string
  if (itemsLeft && accountLeft) {
    message = 'Your account could not be fully removed from the server. What remains is encrypted and can no '
      + 'longer be signed into.'
  } else if (accountLeft) {
    message = 'Your data has been deleted, but your account could not be removed from the server. It can no '
      + 'longer be signed into.'
  } else if (itemsLeft) {
    message = 'Your account has been deleted, but some of its encrypted data could not be removed from the server.'
  } else {
    message = 'Your account has been deleted.'
  }
  if (localFailed) {
    message += " Some data could not be removed from this device: close every Flock tab, then clear this site's "
      + 'data in your browser settings.'
  }
  const clean = !itemsLeft && !accountLeft && !localFailed
  return { severity: clean ? 'success' : 'warning', message }
}
