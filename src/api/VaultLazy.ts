import { Item } from '../state/items'
import { AccountMetadata } from '../state/account'
import { FlockPushSubscription } from '../utils/firebase-types'
import { CryptoResult } from './Vault'

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

export const storeVault = async () => {
  const { storeVault } = await import('./Vault')
  return storeVault()
}

export const signOutVault = async () => {
  const { signOutVault } = await import('./Vault')
  return signOutVault()
}

export const encrypt = async (plaintext: string) => {
  const { encrypt } = await import('./Vault')
  return encrypt(plaintext)
}

export const decrypt = async (result: CryptoResult) => {
  const { decrypt } = await import('./Vault')
  return decrypt(result)
}

export const encryptObject = async (obj: object) => {
  const { encryptObject } = await import('./Vault')
  return encryptObject(obj)
}

export const decryptObject = async (result: CryptoResult) => {
  const { decryptObject } = await import('./Vault')
  return decryptObject(result)
}

export const exportData = async (items: Item[]) => {
  const { exportData } = await import('./Vault')
  return exportData(items)
}

export const importData = async (data: CryptoResult) => {
  const { importData } = await import('./Vault')
  return importData(data)
}

export const storeItems = async (data: Item | Item[]) => {
  const { storeItems } = await import('./Vault')
  return storeItems(data)
}

export const deleteItems = async (data: string | string[]) => {
  const { deleteItems } = await import('./Vault')
  return deleteItems(data)
}

export const fetchAll = async () => {
  const { fetchAll } = await import('./Vault')
  return fetchAll()
}

export const setMetadata = async (metadata: AccountMetadata) => {
  const { setMetadata } = await import('./Vault')
  return setMetadata(metadata)
}

export const getMetadata = async () => {
  const { getMetadata } = await import('./Vault')
  return getMetadata()
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
