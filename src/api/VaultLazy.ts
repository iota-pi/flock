import type { Item } from '../state/items'
import type { FlockPushSubscription } from '../utils/firebase-types'
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

export const getSubscription = async (subscriptionToken: string) => {
  const { getSubscription } = await import('./Vault')
  return getSubscription(subscriptionToken)
}

export const setSubscription = async (subscription: FlockPushSubscription) => {
  const { setSubscription } = await import('./Vault')
  return setSubscription(subscription)
}

export const deleteSubscription = async (subscriptionToken: string) => {
  const { deleteSubscription } = await import('./Vault')
  return deleteSubscription(subscriptionToken)
}
