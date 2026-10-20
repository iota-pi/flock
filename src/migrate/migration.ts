import {
  getActiveKeyVersion,
  getSecurityParams,
  lockVaultKeys,
  loginVault,
  readStoredMetadata,
  reencryptAllItems,
  upgradeKeyDerivation,
  type DataVersionStatus,
} from '@vault/client'
import {
  MIGRATION_CHANNEL,
  MIN_ACCOUNT_DATA_VERSION,
  MIN_DEVICE_DATA_VERSION,
  type MigrationChannelMessage,
} from './detection'
import { clearLegacyLocalData } from './legacy/localData'
import { MigrationBridge, setMigrationAccount } from './migrationBridge'

export class OfflineError extends Error {
  constructor() {
    super('Connect to the internet to update your data.')
    this.name = 'OfflineError'
  }
}

/** The server described an account this device knows uses Argon2id as a PBKDF2 one */
export class KeyDerivationDowngradeError extends Error {
  constructor() {
    super('The server sent unexpected security settings for this account, so you have not been logged in. Please contact support.')
    this.name = 'KeyDerivationDowngradeError'
  }
}

function announce(message: MigrationChannelMessage): void {
  if (typeof BroadcastChannel === 'undefined') return
  const channel = new BroadcastChannel(MIGRATION_CHANNEL)
  channel.postMessage(message)
  channel.close()
}

/**
 * Logs in and asks the main app's tabs to lock, so this tab is the only one using the account.
 * Migration needs the server (to raise the account level, and to change the password), so it
 * refuses to start offline. Returns whether the account still needs a new password (on Argon2id).
 */
export async function startMigration(account: string, password: string): Promise<{ needsNewPassword: boolean }> {
  let params: Awaited<ReturnType<typeof getSecurityParams>>
  try {
    params = await getSecurityParams(account)
  } catch (error) {
    console.warn('[migration] getSecurityParams failed', error)
    throw new OfflineError()
  }

  // A device that has used Argon2id for this account never derives a PBKDF2 key for it again: that
  // would hand the server an auth token far cheaper to guess the password from
  const stored = readStoredMetadata()
  if (!params.kdf && stored?.account === account && stored.kdf) {
    throw new KeyDerivationDowngradeError()
  }

  await loginVault({
    account,
    password,
    salt: params.salt,
    kdf: params.kdf,
    iterations: params.iterations,
    saltVersion: params.saltVersion,
  })

  setMigrationAccount(account)
  // The main app's tabs lock themselves, so this tab's engine is the only one running (and the
  // leader, which the snapshot rewrite needs)
  announce({ type: 'started', account })
  return { needsNewPassword: !params.kdf }
}

/**
 * Moves the account to Argon2id with a new password. It runs before sync starts, and signs out
 * every other session, so no other device keeps writing with the password-derived key v1 while
 * `reencryptOutdatedItems` moves the data off it.
 */
export async function changeToArgon2id(account: string, newPassword: string): Promise<void> {
  await upgradeKeyDerivation(account, newPassword)
}

/** Starts sync with every legacy hook */
export async function beginSync(account: string): Promise<void> {
  await MigrationBridge.initialize(account)
}

/**
 * Blockers that re-encrypting every item clears: it writes each snapshot again under the active key,
 * bound to its item. A device rewrites unbound snapshots only once (`SnapshotFormatUpgrade`), so
 * snapshots an older build uploaded after that stay unbound until this runs.
 */
const REENCRYPTION_BLOCKERS = ['passwordDerivedDataKey', 'unboundSnapshots']

export function needsReencryption(blockers: string[]): boolean {
  return blockers.some(blocker => REENCRYPTION_BLOCKERS.includes(blocker))
}

/**
 * Re-encrypts every item with the active data key. While the password-derived key v1 is still
 * active, rotates to a random key first; after an interrupted run, only re-encrypts what's left.
 */
export async function reencryptOutdatedItems(
  account: string,
  blockers: string[],
  onProgress: (done: number, total: number) => void,
): Promise<{ failed: Array<{ itemId: string, error: string }> }> {
  if (blockers.includes('passwordDerivedDataKey') && getActiveKeyVersion() === '1') {
    return reencryptAllItems(MigrationBridge, account, onProgress)
  }
  return MigrationBridge.reencryptAllItems(onProgress)
}

export function isMigrationComplete(status: DataVersionStatus): boolean {
  return status.device >= MIN_DEVICE_DATA_VERSION && status.account >= MIN_ACCOUNT_DATA_VERSION
}

/** Removes what's left of the legacy local layouts, stops sync and returns to the main app */
export async function finishMigration(account: string): Promise<void> {
  try {
    await clearLegacyLocalData(account)
  } catch (error) {
    console.warn('[migration] Failed to clear legacy local data', error)
  }
  await MigrationBridge.shutdown({ clearLocalData: false, accountId: account })
  await lockVaultKeys()
  announce({ type: 'finished', account })
  window.location.assign('/')
}

const BLOCKER_DESCRIPTIONS: Record<string, string> = {
  legacySettings: 'Settings saved in the old format',
  legacyKeyDerivation: 'The encryption settings for your password',
  unboundSnapshots: 'Items that have not been re-encrypted yet',
  legacyCipherItems: 'Items saved in the old format',
  passwordDerivedDataKey: 'Items still encrypted with a key made from your old password',
}

export function describeBlocker(blocker: string): string {
  return BLOCKER_DESCRIPTIONS[blocker] ?? blocker
}
