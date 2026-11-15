import { KdfParamsSchema, type KdfParams } from '@vault/shared'
import { getVaultStorageNames } from '../shared/storageNames'

/** One account's metadata on this device */
export type VaultStoredMetadata = {
  account: string,
  salt?: string,
  iterations?: number,
  saltVersion?: number,
  /** Argon2id parameters. `keyDerivation` says whether the account is PBKDF2, never their absence. */
  kdf?: KdfParams,
  /**
   * How the account derives its master key, when this device knows. Recorded only from a full set
   * of key derivation parameters, so an entry without them (such as one a biometric unlock created)
   * doesn't read as PBKDF2.
   */
  keyDerivation?: 'argon2id' | 'pbkdf2',
  /**
   * Whether this device has ever derived the account's key with Argon2id. Never cleared while the
   * entry exists, so the migration app can refuse a server that later describes it as PBKDF2.
   */
  usedArgon2id?: boolean,
  /**
   * The highest data key version this device has had active. A keyring the server serves later
   * can't lower it (see "Keyring rollback" in docs/local-encryption.md).
   */
  keyVersion?: string,
}

export type KeyDerivationParams = { salt?: string, iterations?: number, saltVersion?: number, kdf?: KdfParams }

type AccountEntry = Omit<VaultStoredMetadata, 'account'>

/**
 * What's stored: an entry per account, so logging in to one account never drops another's pins.
 * `account` is the last account used here, as it was in the single-account format this replaces.
 */
type StoredMetadataRecord = {
  account?: string,
  accounts: Record<string, AccountEntry>,
}

function parseEntry(raw: unknown): AccountEntry {
  const parsed = (raw && typeof raw === 'object' ? raw : {}) as Partial<VaultStoredMetadata>
  const kdf = KdfParamsSchema.safeParse(parsed.kdf).data
  return {
    salt: typeof parsed.salt === 'string' ? parsed.salt : undefined,
    iterations: typeof parsed.iterations === 'number' ? parsed.iterations : undefined,
    saltVersion: typeof parsed.saltVersion === 'number' ? parsed.saltVersion : undefined,
    kdf,
    keyDerivation: parsed.keyDerivation === 'argon2id' || parsed.keyDerivation === 'pbkdf2'
      ? parsed.keyDerivation
      : undefined,
    usedArgon2id: parsed.usedArgon2id === true || kdf !== undefined || undefined,
    keyVersion: typeof parsed.keyVersion === 'string' && /^\d+$/.test(parsed.keyVersion)
      ? parsed.keyVersion
      : undefined,
  }
}

/**
 * Converts the single-account format earlier builds wrote. Its parameters were written as a set, so
 * a salt without `kdf` was PBKDF2, but a record without a salt says nothing about the account.
 */
function parseLegacyRecord(parsed: Partial<VaultStoredMetadata>): StoredMetadataRecord {
  if (typeof parsed.account !== 'string') return { accounts: {} }
  const entry = parseEntry(parsed)
  if (entry.kdf) {
    entry.keyDerivation = 'argon2id'
  } else if (entry.salt) {
    entry.keyDerivation = 'pbkdf2'
  }
  return { account: parsed.account, accounts: { [parsed.account]: entry } }
}

function readRecord(): StoredMetadataRecord {
  const key = getVaultStorageNames().vaultMetadataKey
  const serialized = localStorage.getItem(key)
  if (!serialized) return { accounts: {} }
  try {
    const parsed = JSON.parse(serialized) as Partial<StoredMetadataRecord> & Partial<VaultStoredMetadata>
    if (!parsed || typeof parsed !== 'object') return { accounts: {} }
    if (!parsed.accounts || typeof parsed.accounts !== 'object') {
      return parseLegacyRecord(parsed)
    }
    const accounts: Record<string, AccountEntry> = {}
    for (const [account, entry] of Object.entries(parsed.accounts)) {
      accounts[account] = parseEntry(entry)
    }
    return {
      account: typeof parsed.account === 'string' ? parsed.account : undefined,
      accounts,
    }
  } catch {
    localStorage.removeItem(key)
    return { accounts: {} }
  }
}

function writeRecord(record: StoredMetadataRecord) {
  localStorage.setItem(getVaultStorageNames().vaultMetadataKey, JSON.stringify(record))
}

/**
 * The metadata for `account`, or for the last account used on this device when none is given.
 * Null when this device has none for it.
 */
export function readStoredMetadata(account?: string): VaultStoredMetadata | null {
  const record = readRecord()
  const target = account ?? record.account
  if (target === undefined) return null
  const entry = record.accounts[target]
  return entry ? { account: target, ...entry } : null
}

/**
 * Records `account` as the last one used here and, when given, its key derivation parameters.
 * They're always given as a set: a missing `kdf` means PBKDF2. Without them, the account's stored
 * ones are kept. Other accounts' entries are never touched.
 */
export function writeStoredMetadata(account: string, params?: KeyDerivationParams) {
  const record = readRecord()
  const existing = record.accounts[account] ?? {}
  const entry: AccountEntry = params
    ? {
      salt: params.salt,
      iterations: params.kdf ? undefined : params.iterations,
      saltVersion: params.saltVersion,
      kdf: params.kdf,
      keyDerivation: params.kdf ? 'argon2id' : 'pbkdf2',
      usedArgon2id: existing.usedArgon2id || params.kdf !== undefined || undefined,
      keyVersion: existing.keyVersion,
    }
    : existing
  writeRecord({ account, accounts: { ...record.accounts, [account]: entry } })
}

/**
 * Whether this device knows the account derives its key with PBKDF2. False when it doesn't know,
 * and for any account it has seen use Argon2id.
 */
export function isStoredAsPbkdf2(account: string): boolean {
  const stored = readStoredMetadata(account)
  return stored?.keyDerivation === 'pbkdf2' && !stored.usedArgon2id
}

/** Whether this device has ever derived the account's key with Argon2id */
export function hasUsedArgon2id(account: string): boolean {
  return readStoredMetadata(account)?.usedArgon2id === true
}

/** The highest data key version this device has had active for the account, if it has recorded one */
export function readKeyVersion(account: string): string | undefined {
  return readStoredMetadata(account)?.keyVersion
}

/**
 * Records that `kver` has been the account's active data key version, if it's above the recorded
 * one. Only for an account this device has metadata for.
 */
export function rememberKeyVersion(account: string, kver: string) {
  if (!/^\d+$/.test(kver)) return
  const record = readRecord()
  const entry = record.accounts[account]
  if (!entry) return
  if (entry.keyVersion !== undefined && parseInt(entry.keyVersion, 10) >= parseInt(kver, 10)) return
  writeRecord({ ...record, accounts: { ...record.accounts, [account]: { ...entry, keyVersion: kver } } })
}

/** Forgets one account's metadata, or every account's when none is given */
export function clearStoredMetadata(account?: string) {
  if (account === undefined) {
    localStorage.removeItem(getVaultStorageNames().vaultMetadataKey)
    return
  }
  const record = readRecord()
  const accounts = { ...record.accounts }
  delete accounts[account]
  if (Object.keys(accounts).length === 0) {
    localStorage.removeItem(getVaultStorageNames().vaultMetadataKey)
    return
  }
  writeRecord({ account: record.account === account ? undefined : record.account, accounts })
}
