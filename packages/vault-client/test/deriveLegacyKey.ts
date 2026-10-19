import type { DeriveLegacyKey } from '../src/api/crypto'

/** PBKDF2-SHA256, as apps provide it through `VaultHostHooks.deriveLegacyKey` */
export const deriveLegacyKey: DeriveLegacyKey = async ({ password, salt, iterations }) => {
  const keyBase = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  return crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, keyBase, 256)
}
