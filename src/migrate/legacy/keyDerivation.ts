import type { DeriveLegacyKey } from '@vault/client'

/**
 * Decodes salts stored before `saltVersion` 1, which Flock fed to PBKDF2 as the UTF-8 bytes of the
 * base64 string rather than the bytes it encodes. Such accounts are upgraded to a current salt at
 * their next online login (stage 2.5d in docs/vault-extraction.md).
 */
export function decodeLegacySalt(salt: string): ArrayBuffer {
  return new TextEncoder().encode(salt).buffer
}

/**
 * PBKDF2-SHA256, for accounts that haven't moved to Argon2id yet (below data level 2, see
 * docs/local-encryption.md). Only the migration app derives PBKDF2 keys: it logs such accounts in
 * to change their password to an Argon2id one.
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
