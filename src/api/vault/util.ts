export const DEFAULT_CRYPTO_ITERATIONS = typeof window !== 'undefined' && window.Cypress ? 1 : 100000

export const VAULT_STORAGE_KEY = 'FlockVaultMeta'

export type VaultStoredMetadata = {
  account: string,
  key: string,
  authToken?: string,
}

export function readStoredMetadata(): VaultStoredMetadata | null {
  const serialized = localStorage.getItem(VAULT_STORAGE_KEY)
  if (serialized) {
    try {
      const parsed = JSON.parse(serialized) as Partial<VaultStoredMetadata>
      if (typeof parsed.account === 'string' && typeof parsed.key === 'string') {
        return {
          account: parsed.account,
          key: parsed.key,
          authToken: parsed.authToken,
        }
      }
    } catch {
      localStorage.removeItem(VAULT_STORAGE_KEY)
    }
  }

  return null
}

export function getStoredVaultKey(): string | null {
  const stored = readStoredMetadata()
  return stored?.key || null
}
