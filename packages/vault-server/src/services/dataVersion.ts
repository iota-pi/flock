import type { VaultAccount, VaultDriver } from '../drivers/vaultDriver'

/**
 * Decides when an account's stored data has been fully migrated to the app's current data
 * version. Each account records the version it has reached (`dataVersion`). New accounts start at
 * the current version. For older ones, clients ask for it to be raised once their migrations have
 * run, and the server raises it only when `findBlockers` finds nothing left to migrate.
 */
export interface DataVersionPolicy {
  /** The version new accounts start at and migrated accounts are raised to */
  current: number
  /** Why the account's data can't be at `current` yet. Empty `blockers` when it can. */
  findBlockers(input: { account: string, accountData: VaultAccount, vault: VaultDriver }): Promise<BlockerReport>
}

export interface BlockerReport {
  /** Short codes for what still holds the account back */
  blockers: string[]
  /**
   * How many live items each item-level blocker still covers, so a client can tell a run that
   * stopped partway from one that never started. Account-level blockers have no count.
   */
  blockedItems?: Record<string, number>
}

export interface RaiseDataVersionResult extends BlockerReport {
  dataVersion: number
}

export async function raiseDataVersion(
  vault: VaultDriver,
  { account, accountData, policy }: {
    account: string
    accountData: VaultAccount
    policy?: DataVersionPolicy
  },
): Promise<RaiseDataVersionResult> {
  const dataVersion = accountData.dataVersion ?? 0
  if (!policy || dataVersion >= policy.current) {
    return { dataVersion, blockers: [] }
  }

  const report = await policy.findBlockers({ account, accountData, vault })
  if (report.blockers.length > 0) {
    return { dataVersion, ...report }
  }

  await vault.raiseDataVersion({ account, dataVersion: policy.current })
  return { dataVersion: policy.current, blockers: [] }
}
