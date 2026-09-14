import { describe, it, expect } from 'vitest'
import { isTransientVaultError, TRANSIENT_VAULT_ERROR_SUBSTRINGS } from './vaultErrors'
import { VaultNotInitializedError } from 'src/api/vault'

describe('isTransientVaultError', () => {
  it('returns false for falsy values', () => {
    expect(isTransientVaultError(null)).toBe(false)
    expect(isTransientVaultError(undefined)).toBe(false)
    expect(isTransientVaultError('')).toBe(false)
  })

  it('returns true for VaultNotInitializedError instance or error with that name', () => {
    expect(isTransientVaultError(new VaultNotInitializedError())).toBe(true)
    const err = new Error('Some message')
    err.name = 'VaultNotInitializedError'
    expect(isTransientVaultError(err)).toBe(true)

    const duckTypedErr = { name: 'VaultNotInitializedError' }
    expect(isTransientVaultError(duckTypedErr)).toBe(true)
  })

  it('returns true for each substring in TRANSIENT_VAULT_ERROR_SUBSTRINGS', () => {
    for (const substring of TRANSIENT_VAULT_ERROR_SUBSTRINGS) {
      expect(isTransientVaultError(new Error(`Prefix ${substring.toUpperCase()} suffix`))).toBe(true)
      expect(isTransientVaultError(`Raw string containing ${substring}`)).toBe(true)
      expect(isTransientVaultError({ message: `Object with ${substring}` })).toBe(true)
    }
  })

  it('returns true for wrapped errors with cause', () => {
    const rootErr = new Error('Vault is locked')
    const wrappedErr = new Error('Snapshot preparation failed', { cause: rootErr })
    expect(isTransientVaultError(wrappedErr)).toBe(true)

    const deepWrappedErr = new Error('Outer error', {
      cause: new Error('Mid error', { cause: new VaultNotInitializedError() }),
    })
    expect(isTransientVaultError(deepWrappedErr)).toBe(true)
  })

  it('returns false for non-transient errors', () => {
    expect(isTransientVaultError(new Error('Corrupt block detected'))).toBe(false)
    expect(isTransientVaultError(new Error('Permission denied'))).toBe(false)
    expect(isTransientVaultError('Unexpected EOF')).toBe(false)
    expect(isTransientVaultError({ message: 'Network timeout' })).toBe(false)
  })
})
