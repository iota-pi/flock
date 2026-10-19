import type { KdfParams } from '@vault/shared'
import type BaseDriver from '../drivers/base'
import type { VaultAccount } from '../drivers/base'

/** The parts of a new account that decide which data version it starts at */
export interface NewAccountInput {
  kdf?: KdfParams
  keyring?: string
  randomDataKeys?: true
}

/**
 * Decides when an account's stored data has been fully migrated to the app's current data
 * version. Each account records the version it has reached (`dataVersion`). New accounts start at
 * `newAccountVersion`. For older ones, clients ask for it to be raised once their migrations have
 * run, and the server raises it only when `findBlockers` finds nothing left to migrate.
 */
export interface DataVersionPolicy {
  /** The version migrated accounts are raised to */
  current: number
  /** Why the account's data can't be at `current` yet, as short codes. Empty when it can. */
  findBlockers(input: { account: string, accountData: VaultAccount, vault: BaseDriver }): Promise<string[]>
  /**
   * The version a new account starts at, from what the client sent. Without it, new accounts get
   * whatever the driver's account defaults set.
   */
  newAccountVersion?(input: NewAccountInput): number
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
