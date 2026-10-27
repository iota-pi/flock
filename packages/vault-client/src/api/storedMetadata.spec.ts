import type { KdfParams } from '@vault/shared'
import { readStoredMetadata, writeStoredMetadata } from './storedMetadata'
import { getVaultStorageNames } from '../sync/shared/storageNames'

const ACCOUNT = 'stored-metadata-account'
const OTHER_ACCOUNT = 'stored-metadata-other-account'
const SALT = 'c3RvcmVkLXNhbHQ='
const KDF: KdfParams = { algorithm: 'argon2id', memoryKiB: 16, passes: 1, parallelism: 1 }

describe('writeStoredMetadata', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('keeps the stored key derivation params when they belong to the same account', () => {
    writeStoredMetadata(ACCOUNT, { salt: SALT, saltVersion: 1, kdf: KDF })

    writeStoredMetadata(ACCOUNT)

    expect(readStoredMetadata()).toMatchObject({ account: ACCOUNT, salt: SALT, saltVersion: 1, kdf: KDF })
  })

  it("doesn't reuse another account's key derivation params", () => {
    writeStoredMetadata(OTHER_ACCOUNT, { salt: SALT, saltVersion: 1, kdf: KDF })

    writeStoredMetadata(ACCOUNT)

    const stored = readStoredMetadata()
    expect(stored?.account).toBe(ACCOUNT)
    expect(stored?.salt).toBeUndefined()
    expect(stored?.iterations).toBeUndefined()
    expect(stored?.saltVersion).toBeUndefined()
    expect(stored?.kdf).toBeUndefined()
    expect(localStorage.getItem(getVaultStorageNames().vaultMetadataKey)).not.toContain(SALT)
  })

  it('uses the given params over the stored ones', () => {
    writeStoredMetadata(ACCOUNT, { salt: 'b2xkLXNhbHQ=', saltVersion: 1, iterations: 1000 })

    writeStoredMetadata(ACCOUNT, { salt: SALT, saltVersion: 2, kdf: KDF })

    const stored = readStoredMetadata()
    expect(stored).toMatchObject({ account: ACCOUNT, salt: SALT, saltVersion: 2, kdf: KDF })
    expect(stored?.iterations).toBeUndefined()
  })
})
