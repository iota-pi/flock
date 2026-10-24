import { KdfParamsSchema, type KdfParams } from '@vault/shared'
import { getVaultStorageNames } from '../sync/shared/storageNames'

export type VaultStoredMetadata = {
  account: string,
  salt?: string,
  iterations?: number,
  saltVersion?: number,
  /** Argon2id parameters. Without them, the account derives its key with PBKDF2 and `iterations`. */
  kdf?: KdfParams,
  /**
   * Whether the account was created with a random data key v1, as the server last said. With it, an
   * active key version of '1' isn't derived from a password, so local data may be sealed with it.
   */
  randomDataKeys?: boolean,
}

export type KeyDerivationParams = { salt?: string, iterations?: number, saltVersion?: number, kdf?: KdfParams }

/**
 * What the server last said about the account's data keys. Login fetches the keyring before it
 * writes a new device's metadata, so the answer is kept until then.
 */
let lastKeyringAnswer: { account: string, randomDataKeys: boolean } | null = null

export function readStoredMetadata(): VaultStoredMetadata | null {
  const serialized = localStorage.getItem(getVaultStorageNames().vaultMetadataKey)
  if (serialized) {
    try {
      const parsed = JSON.parse(serialized) as Partial<VaultStoredMetadata>
      if (typeof parsed.account === 'string') {
        return {
          account: parsed.account,
          salt: typeof parsed.salt === 'string' ? parsed.salt : undefined,
          iterations: typeof parsed.iterations === 'number' ? parsed.iterations : undefined,
          saltVersion: typeof parsed.saltVersion === 'number' ? parsed.saltVersion : undefined,
          kdf: KdfParamsSchema.safeParse(parsed.kdf).data,
          randomDataKeys: parsed.randomDataKeys === true ? true : undefined,
        }
      }
    } catch {
      localStorage.removeItem(getVaultStorageNames().vaultMetadataKey)
    }
  }

  return null
}

/**
 * Records the account and, when given, its key derivation parameters. They're always given as a
 * set: a missing `kdf` means PBKDF2. Without them, the stored ones are kept.
 */
export function writeStoredMetadata(account: string, params?: KeyDerivationParams) {
  const stored = readStoredMetadata()
  const keyParams = params ?? stored
  // Learned from the server separately (see rememberRandomDataKeys), so a key derivation change keeps it
  const randomDataKeys = lastKeyringAnswer?.account === account
    ? lastKeyringAnswer.randomDataKeys || undefined
    : stored?.account === account ? stored.randomDataKeys : undefined
  localStorage.setItem(
    getVaultStorageNames().vaultMetadataKey,
    JSON.stringify({
      account,
      salt: keyParams?.salt,
      iterations: keyParams?.kdf ? undefined : keyParams?.iterations,
      saltVersion: keyParams?.saltVersion,
      kdf: keyParams?.kdf,
      randomDataKeys,
    } satisfies VaultStoredMetadata),
  )
}

/** Records what the server says about the account's data keys, for the sync worker to read at start */
export function rememberRandomDataKeys(account: string, randomDataKeys: boolean) {
  lastKeyringAnswer = { account, randomDataKeys }
  const stored = readStoredMetadata()
  if (stored?.account !== account || stored.randomDataKeys === (randomDataKeys || undefined)) return
  localStorage.setItem(
    getVaultStorageNames().vaultMetadataKey,
    JSON.stringify({ ...stored, randomDataKeys: randomDataKeys || undefined } satisfies VaultStoredMetadata),
  )
}

/** Whether the account's data keys are random, as this device last heard (see `VaultStoredMetadata`) */
export function hasRandomDataKeys(account: string): boolean {
  const stored = readStoredMetadata()
  return stored?.account === account && stored.randomDataKeys === true
}

export function clearStoredMetadata() {
  localStorage.removeItem(getVaultStorageNames().vaultMetadataKey)
}
