import type BaseDriver from '../drivers/base'
import type { VaultAccount } from '../drivers/base'

/**
 * Decides when an account's stored data has been fully migrated to the app's current data
 * version. Each account records the version it has reached (`dataVersion`). New accounts start at
 * the current version. For older ones, clients ask for it to be raised once their migrations have
 * run, and the server raises it only when `findBlockers` finds nothing left to migrate.
 */
export interface DataVersionPolicy {
  /** The version new accounts start at and migrated accounts are raised to */
  current: number
  /** Why the account's data can't be at `current` yet, as short codes. Empty when it can. */
  findBlockers(input: { account: string, accountData: VaultAccount, vault: BaseDriver }): Promise<string[]>
}

export interface RaiseDataVersionResult {
  dataVersion: number
  blockers: string[]
}

export async function raiseDataVersion({
  account,
  accountData,
  vault,
  policy,
}: {
  account: string
  accountData: VaultAccount
  vault: BaseDriver
  policy?: DataVersionPolicy
}): Promise<RaiseDataVersionResult> {
  const dataVersion = accountData.dataVersion ?? 0
  if (!policy || dataVersion >= policy.current) {
    return { dataVersion, blockers: [] }
  }

  const blockers = await policy.findBlockers({ account, accountData, vault })
  if (blockers.length > 0) {
    return { dataVersion, blockers }
  }

  await vault.raiseDataVersion({ account, dataVersion: policy.current })
  return { dataVersion: policy.current, blockers: [] }
}
