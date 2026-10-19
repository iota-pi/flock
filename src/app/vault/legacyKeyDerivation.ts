import type { DeriveLegacyKey } from '@vault/client'

/**
 * PBKDF2-SHA256, for accounts that haven't moved to Argon2id yet (data level 2, see
 * docs/local-encryption.md). The main app only reaches it with parameters cached on the device;
 * it moves to the migration app once no accounts below level 2 remain.
 */
export const deriveLegacyKey: DeriveLegacyKey = async ({ password, salt, iterations }) => {
  const keyBase = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  return crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, keyBase, 256)
}
