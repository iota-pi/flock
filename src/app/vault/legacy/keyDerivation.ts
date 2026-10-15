/**
 * Decodes salts stored before `saltVersion` 1, which Flock fed to PBKDF2 as the UTF-8 bytes of the
 * base64 string rather than the bytes it encodes. Such accounts are upgraded to a current salt at
 * their next online login (stage 2.5d in docs/vault-extraction.md).
 */
export function decodeLegacySalt(salt: string): ArrayBuffer {
  return new TextEncoder().encode(salt).buffer
}
