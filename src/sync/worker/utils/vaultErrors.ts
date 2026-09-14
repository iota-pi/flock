import { VaultNotInitializedError } from 'src/api/vault'

export const TRANSIENT_VAULT_ERROR_SUBSTRINGS = [
  'vault is locked',
  'vaultnotinitializederror',
  'not initialized',
  'active key not found',
] as const

/**
 * Determines whether an error is due to a transient vault state,
 * such as the vault being locked or uninitialized, indicating that
 * the operation cannot proceed immediately but may succeed once unlocked/initialized.
 */
export function isTransientVaultError(error: unknown): boolean {
  if (!error) return false
  if (error instanceof VaultNotInitializedError) return true

  const name = typeof (error as { name?: unknown })?.name === 'string'
    ? (error as { name: string }).name
    : ''
  if (name === 'VaultNotInitializedError') return true

  const rawMessage = typeof (error as { message?: unknown })?.message === 'string'
    ? (error as { message: string }).message
    : error instanceof Error
      ? error.message
      : String(error)
  const message = rawMessage.toLowerCase()

  if (TRANSIENT_VAULT_ERROR_SUBSTRINGS.some((substring) => message.includes(substring))) {
    return true
  }

  const cause = (error as { cause?: unknown })?.cause
  if (cause && cause !== error) {
    return isTransientVaultError(cause)
  }

  return false
}
