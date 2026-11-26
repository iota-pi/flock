import { getVaultStorageNames } from './storageNames'

/**
 * The Web Lock held by the account's active tab, the one tab whose engine syncs. Its name is the old
 * leader lock's, so engines of older builds yield to it too.
 */
export function activeTabLockName(accountId: string): string {
  return `${getVaultStorageNames().accountPrefixes.leaderLock}${accountId}`
}

/** Whether this context can take Web Locks. Without them, every tab runs its engine. */
export function hasWebLocks(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function'
}

const ACTIVE_TAB_TAKEN = 'ActiveTabTakenError'

/** Another tab took the active-tab lock before this tab's engine could, so this engine didn't start */
export class ActiveTabTakenError extends Error {
  constructor() {
    super('Another tab is using this account')
    this.name = ACTIVE_TAB_TAKEN
  }
}

/** Whether `error` is an `ActiveTabTakenError`, including one Comlink rebuilt from its name */
export function isActiveTabTakenError(error: unknown): boolean {
  return error instanceof Error && error.name === ACTIVE_TAB_TAKEN
}
