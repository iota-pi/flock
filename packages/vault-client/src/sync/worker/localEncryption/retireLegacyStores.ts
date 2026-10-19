import { getVaultStorageNames } from '../../shared/storageNames'
import { getAccountDatabaseName } from '../../shared/createAccountStore'
import { clearAutomergeIndexedDb } from '../../client/localDataCleanup'
import { getAutomergeDBName } from '../AutomergeRepoManager'
import { getSyncMetadataStorage, SYNC_METADATA_KEYS } from '../stores/syncMetadataStorage'
import { runStorageOperation } from '../../utils/storageManager'

export interface RetireLegacyStoresOptions {
  accountId: string
  /** Asks other tabs to stop syncing the account. Called only when something else holds its locks. */
  onRetiring?: () => void
  /** How long to wait for other tabs to let go of the account's locks */
  waitMs?: number
  pollMs?: number
  /** How long a blocked database deletion may wait */
  deleteTimeoutMs?: number
}

const DEFAULT_WAIT_MS = 5000
const DEFAULT_POLL_MS = 250
const DEFAULT_DELETE_TIMEOUT_MS = 3000

/** Whether any other engine holds or waits for the account's leader or index lock */
async function isAccountInUse(accountId: string): Promise<boolean> {
  const { accountPrefixes } = getVaultStorageNames()
  const names = new Set([`${accountPrefixes.leaderLock}${accountId}`, `${accountPrefixes.indexLock}${accountId}`])
  const { held = [], pending = [] } = await navigator.locks.query()
  return [...held, ...pending].some(lock => lock.name !== undefined && names.has(lock.name))
}

/**
 * Deletes the plaintext stores once their data has been copied into the sealed ones. Returns whether
 * it did.
 *
 * An engine still running on them (an old build's tab) would reconnect to fresh empty databases and
 * carry on as if the account had no data, so deletion waits until nothing else holds the account's
 * sync locks. This engine hasn't requested them yet: its Repo and leader election start afterwards.
 * If another tab doesn't let go in time, this is retried at the next start.
 */
export async function retireLegacyStores(options: RetireLegacyStoresOptions): Promise<boolean> {
  const { accountId } = options
  if (typeof navigator === 'undefined' || typeof navigator.locks?.query !== 'function') return false

  if (await isAccountInUse(accountId)) {
    options.onRetiring?.()
    const deadline = Date.now() + (options.waitMs ?? DEFAULT_WAIT_MS)
    do {
      await new Promise(resolve => setTimeout(resolve, options.pollMs ?? DEFAULT_POLL_MS))
      if (!(await isAccountInUse(accountId))) break
    } while (Date.now() < deadline)
    if (await isAccountInUse(accountId)) return false
  }

  const timeoutMs = options.deleteTimeoutMs ?? DEFAULT_DELETE_TIMEOUT_MS
  try {
    await clearAutomergeIndexedDb(getAutomergeDBName(accountId), timeoutMs)
    await clearAutomergeIndexedDb(getAccountDatabaseName('wal-entries', accountId), timeoutMs)
  } catch (error) {
    console.warn('[retireLegacyStores] Could not delete the plaintext stores yet; retrying at the next start', error)
    return false
  }
  const metadata = getSyncMetadataStorage(accountId)
  await runStorageOperation(() => metadata.removeItem(SYNC_METADATA_KEYS.INDEX_DOC))
  return true
}
