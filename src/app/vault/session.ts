import { clearVaultDeviceData, lockVaultKeys, readStoredMetadata } from '../../api/vault'
import { useAppStore } from '../../state/store'
import { unsubscribe as unsubscribeFromNotifications } from '../../utils/pushNotifications'
import { SyncBridge } from './syncBridge'
import { clearLegacyLocalData } from './legacy/localData'

export async function loadAccount() {
  const { updateAuth } = useAppStore.getState()
  const stored = readStoredMetadata()
  if (stored?.account) {
    updateAuth({ account: stored.account, initializing: false })
  } else {
    updateAuth({ initializing: false })
  }
}

export async function lockVault() {
  const { updateAuth } = useAppStore.getState()
  await lockVaultKeys()

  await SyncBridge.shutdown({ clearLocalData: false })

  updateAuth({ loggedIn: false })
}

export async function removeVaultFromDevice() {
  const { account, updateAuth } = useAppStore.getState()

  if (account) {
    SyncBridge.requestClearOnShutdown?.(account)
  }

  await SyncBridge.shutdown({ clearLocalData: true, accountId: account })

  if (account) {
    await clearLegacyLocalData(account)
    try {
      await unsubscribeFromNotifications(account)
    } catch (error) {
      console.error('Failed to unsubscribe from notifications', error)
    }
  }
  await clearVaultDeviceData(account || undefined)
  updateAuth({ account: '', loggedIn: false })
}
