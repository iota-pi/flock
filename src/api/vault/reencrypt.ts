import { rotateVaultKey, exportKeyringData } from './index'
import { SyncBridge } from '../../sync/SyncBridge'

export async function reencryptAllItems(
  onProgress?: (done: number, total: number) => void
): Promise<void> {
  // 1. Rotate the key on the main thread (saves to localStorage and updates server)
  await rotateVaultKey()

  // 2. Fetch the updated keyring string
  const newKeyring = await exportKeyringData()
  if (!newKeyring) {
    throw new Error('Keyring not found in memory after rotation')
  }

  // 3. Update the worker's key
  await SyncBridge.updateVaultKey(newKeyring)

  // 4. Run the re-encryption on the worker
  await SyncBridge.reencryptAllItems(onProgress || (() => {}))
}
