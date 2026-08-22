import { rotateVaultKey, exportKeyringData } from './index'
import { SyncBridge } from '../../sync/client/SyncBridge'

export const REENCRYPT_PENDING_KEY_PREFIX = 'vault_reencrypt_pending_'

export async function reencryptAllItems(
  account: string,
  onProgress?: (done: number, total: number) => void
): Promise<void> {
  const pendingKey = `${REENCRYPT_PENDING_KEY_PREFIX}${account}`
  localStorage.setItem(pendingKey, 'true')

  // 1. Rotate the key on the main thread (saves to localStorage and updates server)
  await rotateVaultKey(account)

  // 2. Fetch the updated keyring string
  const newKeyring = await exportKeyringData()
  if (!newKeyring) {
    throw new Error('Keyring not found in memory after rotation')
  }

  // 3. Update the worker's key
  await SyncBridge.updateVaultKey(newKeyring)

  // 4. Run the re-encryption on the worker
  await SyncBridge.reencryptAllItems(onProgress || (() => {}))

  localStorage.removeItem(pendingKey)
}

export async function resumePendingReencryption(account: string): Promise<void> {
  const pendingKey = `${REENCRYPT_PENDING_KEY_PREFIX}${account}`
  if (localStorage.getItem(pendingKey) === 'true') {
    console.info(`[vault] Resuming interrupted re-encryption for ${account}...`)
    try {
      await SyncBridge.reencryptAllItems(() => {})
      localStorage.removeItem(pendingKey)
      console.info(`[vault] Resumed re-encryption completed successfully.`)
    } catch (err) {
      console.error(`[vault] Failed to resume re-encryption:`, err)
    }
  }
}
