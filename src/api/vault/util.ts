const isCypress = typeof window !== 'undefined' && window.Cypress
export const DEFAULT_CRYPTO_ITERATIONS = isCypress ? 1 : 600000
export const LEGACY_CRYPTO_ITERATIONS = isCypress ? 1 : 100000

export const VAULT_STORAGE_KEY = 'FlockVaultMeta'

export type VaultStoredMetadata = {
  account: string,
}

export function readStoredMetadata(): VaultStoredMetadata | null {
  const serialized = localStorage.getItem(VAULT_STORAGE_KEY)
  if (serialized) {
    try {
      const parsed = JSON.parse(serialized) as Partial<VaultStoredMetadata>
      if (typeof parsed.account === 'string') {
        return {
          account: parsed.account,
        }
      }
    } catch {
      localStorage.removeItem(VAULT_STORAGE_KEY)
    }
  }

  return null
}

