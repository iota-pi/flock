import { rotateVaultKey, exportKeyringData } from './vault'
import { createLogger } from '../utils/logger'
import type { ReencryptCallOptions, ReencryptResult } from '../shared/types'
import { reencryptPendingKey } from './reencryptPending'

const log = createLogger('reencrypt')

/** The parts of the sync bridge that re-encryption drives */
export interface ReencryptionTarget {
  updateVaultKey(vaultKey: string): Promise<void>
  reencryptAllItems(onProgress?: (done: number, total: number) => void, options?: ReencryptCallOptions): Promise<ReencryptResult>
  /** Waits until a re-encryption could push, without rewriting anything */
  prepareReencryption(options?: ReencryptCallOptions): Promise<void>
}

/**
 * Rotates to a new random data key and re-encrypts every item with it. It first waits until the
 * worker could push, so that a device that can't (another tab holds the leadership, or first start
 * hasn't run) gives up with nothing changed rather than leaving the key rotated and nothing rewritten.
 */
export async function reencryptAllItems(
  syncBridge: ReencryptionTarget,
  account: string,
  onProgress?: (done: number, total: number) => void,
  options: ReencryptCallOptions = {},
): Promise<ReencryptResult> {
  await syncBridge.prepareReencryption(options)

  const pendingKey = reencryptPendingKey(account)
  localStorage.setItem(pendingKey, 'true')

  // 1. Rotate the key on the main thread (saves to localStorage and updates server)
  try {
    await rotateVaultKey(account)
  } catch (err) {
    // Nothing was rotated, so there is nothing to resume
    localStorage.removeItem(pendingKey)
    throw err
  }

  // 2. Fetch the updated keyring string
  const newKeyring = await exportKeyringData()
  if (!newKeyring) {
    throw new Error('Keyring not found in memory after rotation')
  }

  // 3. Update the worker's key
  await syncBridge.updateVaultKey(newKeyring)

  // 4. Run the re-encryption on the worker
  const result = await syncBridge.reencryptAllItems(onProgress || (() => {}), options)

  localStorage.removeItem(pendingKey)
  return result
}

export async function resumePendingReencryption(syncBridge: ReencryptionTarget, account: string): Promise<void> {
  const pendingKey = reencryptPendingKey(account)
  if (localStorage.getItem(pendingKey) === 'true') {
    log.info(`Resuming interrupted re-encryption for ${account}...`)
    try {
      await syncBridge.reencryptAllItems(() => {})
      localStorage.removeItem(pendingKey)
      log.info(`Resumed re-encryption completed successfully.`)
    } catch (err) {
      log.error(`Failed to resume re-encryption:`, err)
    }
  }
}
