import { getVaultStorageNames } from './storageNames'

/** The IndexedDB database holding an account's Automerge documents unsealed */
export function getAutomergeDBName(accountId: string): string {
  return `${getVaultStorageNames().accountPrefixes.automergeDatabase}${accountId}`
}

/** The IndexedDB database holding an account's Automerge documents, sealed with the device storage key */
export function getSealedAutomergeDBName(accountId: string): string {
  return `${getVaultStorageNames().accountPrefixes.sealedAutomergeDatabase}${accountId}`
}

/** The IndexedDB database older builds kept an account's plaintext write-ahead log in */
export function getWalDBName(accountId: string): string {
  return `${getVaultStorageNames().accountPrefixes.walDatabase}${accountId}`
}

/** The IndexedDB database older builds kept an account's sealed write-ahead log in */
export function getSealedWalDBName(accountId: string): string {
  return `${getVaultStorageNames().accountPrefixes.sealedWalDatabase}${accountId}`
}
