import { getVaultStorageNames } from '../shared/storageNames'
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
 * A cached keyring the master key can't open is kept: the password may just be mistyped, and
 * clearing it would lock an offline user out until the server is reachable. When the password has
 * really changed, the next login the server accepts replaces it.
 */
export async function loadCachedKeyring(): Promise<boolean> {
  const cachedKeyring = readCachedKeyring()
  if (!cachedKeyring) return false
  try {
    await vaultKeys.loadEncryptedKeyring(cachedKeyring)
    return true
  } catch {
    return false
  }
}
