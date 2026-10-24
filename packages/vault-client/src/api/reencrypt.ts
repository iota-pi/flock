import { rotateVaultKey, exportKeyringData } from './vault'
import { createLogger } from '../sync/utils/logger'
import type { ReencryptResult } from '../sync/worker/syncProtocol'

const log = createLogger('reencrypt')

/** The parts of the sync bridge that re-encryption drives */
export interface ReencryptionTarget {
  updateVaultKey(vaultKey: string): Promise<void>
  reencryptAllItems(onProgress?: (done: number, total: number) => void): Promise<ReencryptResult>
}

export const REENCRYPT_PENDING_KEY_PREFIX = 'vault_reencrypt_pending_'

export async function reencryptAllItems(
  syncBridge: ReencryptionTarget,
  account: string,
  onProgress?: (done: number, total: number) => void
): Promise<ReencryptResult> {
  const pendingKey = `${REENCRYPT_PENDING_KEY_PREFIX}${account}`
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
  const result = await syncBridge.reencryptAllItems(onProgress || (() => {}))

  localStorage.removeItem(pendingKey)
  return result
}

export async function resumePendingReencryption(syncBridge: ReencryptionTarget, account: string): Promise<void> {
  const pendingKey = `${REENCRYPT_PENDING_KEY_PREFIX}${account}`
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
