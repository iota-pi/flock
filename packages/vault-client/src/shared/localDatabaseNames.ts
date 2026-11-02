import { getVaultStorageNames } from './storageNames'

/** The IndexedDB database holding an account's Automerge documents, sealed with the device storage key */
export function getSealedAutomergeDBName(accountId: string): string {
  return `${getVaultStorageNames().accountPrefixes.sealedAutomergeDatabase}${accountId}`
}
