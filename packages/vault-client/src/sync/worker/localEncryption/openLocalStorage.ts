import type { StorageKey } from '@automerge/automerge-repo/slim'
import { getAutomergeDBName } from '../AutomergeRepoManager'
import { VaultIndexedDBStorageAdapter } from '../VaultIndexedDBStorageAdapter'
import { getSealedAutomergeDBName } from '../../shared/localDatabaseNames'
import { databaseExists as defaultDatabaseExists } from '../../utils/databaseExists'
import { isQuotaError } from '../../utils/storageQuota'
import type { LocalKeyWrapper } from '../../../api/Keyring'
import { LocalCipher, LocalKeyUnavailableError } from './LocalCipher'
import { createSealedRecordCodec } from './sealedRecordCodec'
import { LocalEncryptionUpgrade, UPGRADED_AT_KEY, type LocalEncryptionUpgradeDeps } from './LocalEncryptionUpgrade'

/** The sealed database's `meta` key for the wrapped device storage key */
export const DSK_KEY = 'dsk'
const SEALED_DB_VERSION = 1
const META_STORE = 'meta'

/** The account's local storage, chosen before the Repo is created */
export interface LocalStorage {
  mode: 'plaintext' | 'sealed'
  storage: VaultIndexedDBStorageAdapter
  /** Seals the WAL and index. Set in sealed mode. */
  cipher?: LocalCipher
  /** Sealed, with no plaintext stores left */
  retired: boolean
}

export interface OpenLocalStorageOptions {
  accountId: string
  /** Seal local data, upgrading plaintext data first */
  upgradeLocalEncryption?: boolean
  keys?: LocalKeyWrapper
  /** Whether the account's data keys are random, so an active version of '1' may wrap the DSK */
  randomDataKeys?: boolean
  /** Asks other tabs to stop before the plaintext stores are deleted */
  onRetiring?: () => void
  /** Called for each sealed chunk that fails to decrypt */
  onOpenFailure?: (key: StorageKey, error: unknown) => void
  /** Called when the first upgrade ran out of space, so this session runs on the plaintext stores */
  onQuotaFallback?: (error: unknown) => void
  databaseExists?: (name: string) => Promise<boolean>
  upgradeDeps?: Partial<LocalEncryptionUpgradeDeps>
}

function isConstraintError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'ConstraintError'
}

function openPlaintext(accountId: string): LocalStorage {
  return { mode: 'plaintext', storage: new VaultIndexedDBStorageAdapter(getAutomergeDBName(accountId)), retired: false }
}

/**
 * Opens the account's local storage. Runs under the account's local data lock, before the Repo or
 * any store reads local data, so the storage it picks is the only one this session uses.
 *
 * With `upgradeLocalEncryption`, this loads (or creates) the device storage key and seals any
 * plaintext data first. It never creates a key that would make existing sealed records unreadable,
 * and it never wraps one with a password-derived data key.
 */
export async function openLocalStorage(options: OpenLocalStorageOptions): Promise<LocalStorage> {
  const { accountId, keys } = options
  if (!options.upgradeLocalEncryption || !keys) return openPlaintext(accountId)

  // Data key v1 of an account created before random data keys is derived from its first password
  const activeKeyIsRandom = keys.activeVersion !== '1' || options.randomDataKeys === true
  const databaseExists = options.databaseExists ?? defaultDatabaseExists
  const sealedName = getSealedAutomergeDBName(accountId)
  if (!activeKeyIsRandom && !(await databaseExists(sealedName))) return openPlaintext(accountId)

  let cipher: LocalCipher | undefined
  const sealed = new VaultIndexedDBStorageAdapter(sealedName, {
    version: SEALED_DB_VERSION,
    extraStores: [META_STORE],
    codec: createSealedRecordCodec(() => {
      if (!cipher) throw new LocalKeyUnavailableError()
      return cipher
    }),
    onOpenFailure: options.onOpenFailure,
  })

  try {
    cipher = await loadDeviceKey(sealed, keys, accountId, activeKeyIsRandom)
  } catch (error) {
    await sealed.close()
    throw error
  }
  if (!cipher) {
    await sealed.close()
    return openPlaintext(accountId)
  }

  const upgrade = new LocalEncryptionUpgrade({
    accountId,
    sealed,
    cipher,
    onRetiring: options.onRetiring,
    databaseExists,
    ...options.upgradeDeps,
  })
  try {
    const { retired } = await upgrade.run()
    return { mode: 'sealed', storage: sealed, cipher, retired }
  } catch (error) {
    if (!isQuotaError(error)) {
      await sealed.close()
      throw error
    }
    options.onQuotaFallback?.(error)
    // Before the first upgrade has finished, only the plaintext stores are complete. After it, they
    // hold at most an old tab's recent writes, which the next start copies again.
    if ((await sealed.getMeta(UPGRADED_AT_KEY)) !== undefined) {
      return { mode: 'sealed', storage: sealed, cipher, retired: false }
    }
    await sealed.close()
    return openPlaintext(accountId)
  }
}

/**
 * Unwraps the stored device storage key, or creates one for an empty sealed database. Returns
 * undefined when the database is empty and the active data key may be password-derived.
 */
async function loadDeviceKey(
  sealed: VaultIndexedDBStorageAdapter,
  keys: LocalKeyWrapper,
  accountId: string,
  activeKeyIsRandom: boolean,
): Promise<LocalCipher | undefined> {
  const wrap = await sealed.getMeta(DSK_KEY)
  if (wrap !== undefined) return LocalCipher.unwrap(wrap, keys, accountId)

  // A new key would make every existing record unreadable, so the data is left for recovery instead
  if (await sealed.has([])) throw new LocalKeyUnavailableError()
  if (!activeKeyIsRandom) return undefined

  const created = await LocalCipher.create(keys, accountId)
  try {
    await sealed.addMeta(DSK_KEY, created.wrap)
    return created.cipher
  } catch (error) {
    // Another engine created one first
    if (!isConstraintError(error)) throw error
    return LocalCipher.unwrap(await sealed.getMeta(DSK_KEY), keys, accountId)
  }
}
