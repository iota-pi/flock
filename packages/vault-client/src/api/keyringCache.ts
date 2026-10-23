import { getVaultStorageNames } from '../sync/shared/storageNames'
import { vaultKeys } from './VaultKeyState'

export function readCachedKeyring(): string | null {
  if (typeof localStorage === 'undefined') return null
  return localStorage.getItem(getVaultStorageNames().keyringCacheKey)
}

export function writeCachedKeyring(encryptedKeyring: string): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(getVaultStorageNames().keyringCacheKey, encryptedKeyring)
}

export function clearCachedKeyring(): void {
  if (typeof localStorage === 'undefined') return
  localStorage.removeItem(getVaultStorageNames().keyringCacheKey)
}

/**
 * Loads the cached keyring for offline use. Returns whether it loaded, which verifies the master key.
 * A cached keyring the master key can't open is cleared.
 */
export async function loadCachedKeyring(): Promise<boolean> {
  const cachedKeyring = readCachedKeyring()
  if (!cachedKeyring) return false
  try {
    await vaultKeys.loadEncryptedKeyring(cachedKeyring)
    return true
  } catch {
    clearCachedKeyring()
    return false
  }
}
