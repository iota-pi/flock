import type { KdfParams } from '@vault/shared'
import { readKeyVersion, readStoredMetadata, rememberKeyVersion, writeStoredMetadata } from './storedMetadata'
import { getVaultStorageNames } from '../shared/storageNames'

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

describe('rememberKeyVersion', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('only ever raises the recorded version', () => {
    writeStoredMetadata(ACCOUNT)

    rememberKeyVersion(ACCOUNT, '2')
    rememberKeyVersion(ACCOUNT, '1')
    expect(readKeyVersion(ACCOUNT)).toBe('2')

    rememberKeyVersion(ACCOUNT, '10')
    expect(readKeyVersion(ACCOUNT)).toBe('10')
  })

  it('keeps the version when the metadata is rewritten for the same account', () => {
    writeStoredMetadata(ACCOUNT)
    rememberKeyVersion(ACCOUNT, '3')

    writeStoredMetadata(ACCOUNT, { salt: SALT, saltVersion: 2, kdf: KDF })

    expect(readKeyVersion(ACCOUNT)).toBe('3')
  })

  it("drops another account's version and records nothing for an account without metadata", () => {
    writeStoredMetadata(OTHER_ACCOUNT)
    rememberKeyVersion(OTHER_ACCOUNT, '3')
    rememberKeyVersion(ACCOUNT, '4')
    expect(readKeyVersion(ACCOUNT)).toBeUndefined()

    writeStoredMetadata(ACCOUNT)

    expect(readKeyVersion(ACCOUNT)).toBeUndefined()
    expect(readKeyVersion(OTHER_ACCOUNT)).toBeUndefined()
  })
})
