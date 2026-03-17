import type { Item } from '../state/items'
import type { WebPushSubscription } from '../vault/types'
import type { CryptoResult } from './Vault'

// Lazy wrappers for Vault functions

export const loginVault = async (args: { password: string, salt: string }) => {
  const { loginVault } = await import('./Vault')
  return loginVault(args)
}

export const initialiseVault = async (args: { password: string, isNewAccount?: boolean, iterations?: number, salt: string }) => {
  const { initialiseVault } = await import('./Vault')
  return initialiseVault(args)
}

export const fetchSalt = async () => {
  const { vaultGetSalt } = await import('./VaultAPI')
  return vaultGetSalt()
}

export const createAccount = async (args: { salt: string, authToken: string }) => {
  const { vaultCreateAccount } = await import('./VaultAPI')
  return vaultCreateAccount(args)
}

export const loadVault = async () => {
  const { loadVault } = await import('./Vault')
  return loadVault()
}

export const signOutVault = async () => {
  const { signOutVault } = await import('./Vault')
  return signOutVault()
}

export const exportData = async (items: Item[]) => {
  const { exportData } = await import('./Vault')
  return exportData(items)
}

export const importData = async (data: CryptoResult) => {
  const { importData } = await import('./Vault')
  return importData(data)
}

export const addPushSubscription = async (subscription: WebPushSubscription) => {
  const { addPushSubscription } = await import('./Vault')
  return addPushSubscription(subscription)
}

export const deletePushSubscription = async (endpoint: string) => {
  const { deletePushSubscription } = await import('./Vault')
  return deletePushSubscription(endpoint)
}

export const updateReminderSettings = async (
  settings: { reminderEnabled: boolean, reminderTime: string, reminderTimezone: string },
) => {
  const { updateReminderSettings } = await import('./Vault')
  return updateReminderSettings(settings)
}

export const recordPrayerCompletion = async (completedAt?: number) => {
  const { recordPrayerCompletion } = await import('./Vault')
  return recordPrayerCompletion(completedAt)
}
