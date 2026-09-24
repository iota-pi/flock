export { TRANSIENT_VAULT_ERROR_SUBSTRINGS } from './errorClassifier'
import { classifySyncError } from './errorClassifier'

/**
 * Determines whether an error is due to a transient vault state,
 * such as the vault being locked or uninitialized, indicating that
 * the operation cannot proceed immediately but may succeed once unlocked/initialized.
 */
export function isTransientVaultError(error: unknown): boolean {
  return classifySyncError(error).isTransientVault
}

