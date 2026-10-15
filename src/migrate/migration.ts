import { getSecurityParams, lockVaultKeys, loginVault, type DataVersionStatus } from '@vault/client'
import { MIGRATION_CHANNEL, MIN_DATA_VERSION, type MigrationChannelMessage } from './detection'
import { clearLegacyLocalData } from './legacy/localData'
import { MigrationBridge, setMigrationAccount } from './migrationBridge'

export class OfflineError extends Error {
  constructor() {
    super('Connect to the internet to update your data.')
    this.name = 'OfflineError'
  }
}

function announce(message: MigrationChannelMessage): void {
  if (typeof BroadcastChannel === 'undefined') return
  const channel = new BroadcastChannel(MIGRATION_CHANNEL)
  channel.postMessage(message)
  channel.close()
}

/**
 * Logs in and starts sync with every legacy hook. Migration needs the server (to raise the account
 * level, and to upgrade the key derivation), so it refuses to start offline.
 */
export async function startMigration(account: string, password: string): Promise<void> {
  let params: Awaited<ReturnType<typeof getSecurityParams>>
  try {
    params = await getSecurityParams(account)
  } catch (error) {
    console.warn('[migration] getSecurityParams failed', error)
    throw new OfflineError()
  }

  await loginVault({
    account,
    password,
    salt: params.salt,
    iterations: params.iterations,
    saltVersion: params.saltVersion,
  })

  setMigrationAccount(account)
  // The main app's tabs lock themselves, so this tab's engine is the only one running (and the
  // leader, which the snapshot rewrite needs)
  announce({ type: 'started', account })
  await MigrationBridge.initialize(account)
}

export function isMigrationComplete(status: DataVersionStatus): boolean {
  return status.device >= MIN_DATA_VERSION && status.account >= MIN_DATA_VERSION
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
}

export function describeBlocker(blocker: string): string {
  return BLOCKER_DESCRIPTIONS[blocker] ?? blocker
}
