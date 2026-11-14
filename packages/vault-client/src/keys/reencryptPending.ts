/**
 * Marks an account whose re-encryption started on this device, so that an interrupted one resumes
 * on the next start. Kept apart from `reencrypt.ts` so that `clearVaultDeviceData` can clear it.
 */
export const REENCRYPT_PENDING_KEY_PREFIX = 'vault_reencrypt_pending_'

export function reencryptPendingKey(account: string): string {
  return `${REENCRYPT_PENDING_KEY_PREFIX}${account}`
}

export function clearPendingReencryption(account: string): void {
  localStorage.removeItem(reencryptPendingKey(account))
}
