import type { KdfParams } from '@vault/shared'
import {
  clearStoredMetadata,
  hasUsedArgon2id,
  isStoredAsPbkdf2,
  readKeyVersion,
  readStoredMetadata,
  rememberKeyVersion,
  writeStoredMetadata,
} from './storedMetadata'
import { getVaultStorageNames } from '../shared/storageNames'

const ACCOUNT = 'stored-metadata-account'
const OTHER_ACCOUNT = 'stored-metadata-other-account'
const SALT = 'c3RvcmVkLXNhbHQ='
const KDF: KdfParams = { algorithm: 'argon2id', memoryKiB: 16, passes: 1, parallelism: 1 }

function writeRaw(value: unknown) {
  localStorage.setItem(getVaultStorageNames().vaultMetadataKey, JSON.stringify(value))
}

describe('writeStoredMetadata', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('keeps the stored key derivation params when called without them', () => {
    writeStoredMetadata(ACCOUNT, { salt: SALT, saltVersion: 1, kdf: KDF })

    writeStoredMetadata(ACCOUNT)

    expect(readStoredMetadata()).toMatchObject({ account: ACCOUNT, salt: SALT, saltVersion: 1, kdf: KDF })
  })

  it("keeps each account's params when another account logs in", () => {
    writeStoredMetadata(ACCOUNT, { salt: SALT, saltVersion: 1, kdf: KDF })
    rememberKeyVersion(ACCOUNT, '3')

    writeStoredMetadata(OTHER_ACCOUNT, { salt: 'b3RoZXI=', saltVersion: 1, kdf: KDF })

    expect(readStoredMetadata()?.account).toBe(OTHER_ACCOUNT)
    expect(readStoredMetadata(ACCOUNT)).toMatchObject({ salt: SALT, kdf: KDF, keyVersion: '3', usedArgon2id: true })
  })

  it('gives an account first seen without params no key derivation', () => {
    writeStoredMetadata(OTHER_ACCOUNT, { salt: SALT, saltVersion: 1, kdf: KDF })

    writeStoredMetadata(ACCOUNT)

    const stored = readStoredMetadata(ACCOUNT)
    expect(stored).toMatchObject({ account: ACCOUNT })
    expect(stored?.salt).toBeUndefined()
    expect(stored?.kdf).toBeUndefined()
    expect(stored?.keyDerivation).toBeUndefined()
    expect(isStoredAsPbkdf2(ACCOUNT)).toBe(false)
  })

  it('uses the given params over the stored ones', () => {
    writeStoredMetadata(ACCOUNT, { salt: 'b2xkLXNhbHQ=', saltVersion: 1, iterations: 1000 })
    expect(isStoredAsPbkdf2(ACCOUNT)).toBe(true)

    writeStoredMetadata(ACCOUNT, { salt: SALT, saltVersion: 2, kdf: KDF })

    const stored = readStoredMetadata(ACCOUNT)
    expect(stored).toMatchObject({ account: ACCOUNT, salt: SALT, saltVersion: 2, kdf: KDF, keyDerivation: 'argon2id' })
    expect(stored?.iterations).toBeUndefined()
    expect(isStoredAsPbkdf2(ACCOUNT)).toBe(false)
  })

  it('never forgets that the account used Argon2id', () => {
    writeStoredMetadata(ACCOUNT, { salt: SALT, saltVersion: 1, kdf: KDF })

    writeStoredMetadata(ACCOUNT, { salt: SALT, iterations: 100_000 })

    expect(hasUsedArgon2id(ACCOUNT)).toBe(true)
    expect(isStoredAsPbkdf2(ACCOUNT)).toBe(false)
  })
})

describe('readStoredMetadata', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('reads the single-account format, with a salt and no kdf as PBKDF2', () => {
    writeRaw({ account: ACCOUNT, salt: SALT, iterations: 600000, keyVersion: '2' })

    expect(readStoredMetadata()).toMatchObject({ account: ACCOUNT, salt: SALT, iterations: 600000, keyVersion: '2' })
    expect(isStoredAsPbkdf2(ACCOUNT)).toBe(true)
    expect(hasUsedArgon2id(ACCOUNT)).toBe(false)
  })

  it('reads the single-account format with a kdf as Argon2id', () => {
    writeRaw({ account: ACCOUNT, salt: SALT, saltVersion: 1, kdf: KDF })

    expect(hasUsedArgon2id(ACCOUNT)).toBe(true)
    expect(isStoredAsPbkdf2(ACCOUNT)).toBe(false)
  })

  it("doesn't read a single-account record without a salt as PBKDF2", () => {
    writeRaw({ account: ACCOUNT, keyVersion: '2' })

    expect(readStoredMetadata(ACCOUNT)?.keyVersion).toBe('2')
    expect(isStoredAsPbkdf2(ACCOUNT)).toBe(false)
  })

  it('returns null for an account without an entry', () => {
    writeStoredMetadata(OTHER_ACCOUNT)

    expect(readStoredMetadata(ACCOUNT)).toBeNull()
  })

  it('drops malformed JSON', () => {
    localStorage.setItem(getVaultStorageNames().vaultMetadataKey, '{')

    expect(readStoredMetadata()).toBeNull()
    expect(localStorage.getItem(getVaultStorageNames().vaultMetadataKey)).toBeNull()
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

  it("keeps each account's version and records nothing for an account without metadata", () => {
    writeStoredMetadata(OTHER_ACCOUNT)
    rememberKeyVersion(OTHER_ACCOUNT, '3')
    rememberKeyVersion(ACCOUNT, '4')
    expect(readKeyVersion(ACCOUNT)).toBeUndefined()

    writeStoredMetadata(ACCOUNT)

    expect(readKeyVersion(ACCOUNT)).toBeUndefined()
    expect(readKeyVersion(OTHER_ACCOUNT)).toBe('3')
  })
})

describe('clearStoredMetadata', () => {
  beforeEach(() => {
    localStorage.clear()
    writeStoredMetadata(OTHER_ACCOUNT, { salt: SALT, saltVersion: 1, kdf: KDF })
    writeStoredMetadata(ACCOUNT, { salt: SALT, saltVersion: 1, kdf: KDF })
  })

  it("removes only the given account's entry", () => {
    clearStoredMetadata(ACCOUNT)

    expect(readStoredMetadata(ACCOUNT)).toBeNull()
    expect(readStoredMetadata()).toBeNull()
    expect(hasUsedArgon2id(OTHER_ACCOUNT)).toBe(true)
  })

  it('keeps the last account when another is removed', () => {
    clearStoredMetadata(OTHER_ACCOUNT)

    expect(readStoredMetadata()?.account).toBe(ACCOUNT)
  })

  it('removes everything without an account', () => {
    clearStoredMetadata()

    expect(localStorage.getItem(getVaultStorageNames().vaultMetadataKey)).toBeNull()
  })
})
