import {
  decryptBytesWithKey,
  decryptWithAssociatedData,
  decryptWithKey,
  encryptBytesWithKey,
  encryptWithAssociatedData,
  encryptWithKey,
  exportVaultKey,
  importVaultKey,
  type CryptoResult,
  type DocBindingPurpose,
} from './crypto'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'
import { createLogger } from '../utils/logger'

const log = createLogger('keyring')

/** The data keys the sync engine encrypts and decrypts with */
export interface KeyProvider {
  /** Whether the key with this version (or the active key) is loaded */
  hasKey(kver?: string): boolean
  /** Waits up to `timeoutMs` for the key with this version to be loaded. Returns whether it was. */
  waitForKey(kver: string, timeoutMs?: number): Promise<boolean>
  /**
   * Encrypts with the active key. Pass the `docId` of the document the bytes belong to, to bind them
   * to it, and `purpose` when they are something other than the document itself.
   */
  encryptBytes(bytes: Uint8Array, docId?: string, purpose?: DocBindingPurpose): Promise<CryptoResult>
  decryptBytes(data: CryptoResult, docId?: string, purpose?: DocBindingPurpose): Promise<Uint8Array>
}

/** A device key encrypted with data key `kver` */
export interface LocalKeyWrap {
  kver: string
  iv: Uint8Array
  ct: Uint8Array
}

/**
 * Wraps the device's local storage key with the data keys. Kept apart from `KeyProvider` because only
 * local storage needs ciphertexts bound to arbitrary associated data.
 */
export interface LocalKeyWrapper {
  readonly activeVersion: string
  hasKey(kver?: string): boolean
  /** Encrypts `raw` with the active key, bound to `associatedData` */
  wrapLocalKey(raw: Uint8Array, associatedData: Uint8Array): Promise<LocalKeyWrap>
  /** Decrypts a wrap with the key it names. Throws when that key is missing or the wrap doesn't verify. */
  unwrapLocalKey(wrap: LocalKeyWrap, associatedData: Uint8Array): Promise<Uint8Array>
}

export class VaultNotInitializedError extends Error {
  constructor() {
    super('Vault must be initialised before use')
    this.name = 'VaultNotInitializedError'
  }
}

/**
 * Thrown instead of encrypting with a password-derived data key v1 when a newer key is known to
 * exist, as when the server serves a keyring from before a rotation (see "Keyring rollback" in
 * docs/local-encryption.md)
 */
export class StaleKeyringError extends Error {
  constructor(readonly knownVersion: string) {
    super(`The keyring is older than key version ${knownVersion}, so nothing is encrypted until it loads`)
    this.name = 'StaleKeyringError'
  }
}

/** A key version as a number, for comparing versions. Anything that isn't a version counts as 0. */
export function keyVersionNumber(kver: string | undefined): number {
  if (!kver || !/^\d+$/.test(kver)) return 0
  return parseInt(kver, 10)
}

type KeyVersionWaiter = {
  kver: string
  resolve: (found: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

/** Key versions and their exported keys, plus `activeVersion` (the format `export` writes) */
export type ExportedKeyring = Record<string, string>

/** The field `exportForWorker` adds: the highest key version the exporting realm knows of */
const KNOWN_VERSION_FIELD = 'knownVersion'

/** Parses a keyring written by `Keyring.export`. Only numeric entries are keys; other fields are ignored. */
export async function importKeyring(exported: ExportedKeyring): Promise<{
  keys: Map<string, CryptoKey>
  activeVersion: string
}> {
  if (!exported || typeof exported !== 'object' || !exported.activeVersion) {
    throw new Error('Not a structured keyring')
  }
  const entries = await Promise.all(
    Object.entries(exported)
      .filter(([ver]) => /^\d+$/.test(ver))
      .map(async ([ver, expKey]) => [ver, await importVaultKey(expKey)] as const)
  )
  return { keys: new Map(entries), activeVersion: exported.activeVersion }
}

/** The account's data keys, by version, in one realm */
export class Keyring implements KeyProvider, LocalKeyWrapper {
  private keys = new Map<string, CryptoKey>()
  private active = '1'
  /** The highest key version this keyring has seen: loaded, pinned, or named by a ciphertext */
  private known = 0
  /** Whether data key v1 is derived from the account's first password (see `assertActiveUsable`) */
  private v1PasswordDerived = false
  private warnedStaleVersions = new Set<number>()
  private waiters = new Set<KeyVersionWaiter>()

  get activeVersion(): string {
    return this.active
  }

  /** The highest key version known to exist, which is above the active one when this keyring is stale */
  get knownVersion(): string {
    return String(Math.max(this.known, keyVersionNumber(this.active)))
  }

  /** Whether a key newer than the active one is known to exist */
  get isStale(): boolean {
    return this.known > keyVersionNumber(this.active)
  }

  /** Records that key version `kver` exists, whether or not it is loaded here */
  noteKeyVersion(kver: string | undefined): void {
    this.known = Math.max(this.known, keyVersionNumber(kver))
  }

  /**
   * Sets whether data key v1 is derived from a password, as on accounts created before random
   * data keys. Such a keyring refuses to encrypt with v1 once a newer key is known.
   */
  setV1PasswordDerived(derived: boolean): void {
    this.v1PasswordDerived = derived
  }

  hasKey(kver?: string): boolean {
    return this.keys.has(kver || this.active)
  }

  /** Returns the key with this version, or the active key */
  private getKey(kver?: string): CryptoKey {
    if (!kver) {
      const key = this.keys.get(this.active)
      if (!key) {
        throw new VaultNotInitializedError()
      }
      return key
    }
    const key = this.keys.get(kver)
    if (!key) {
      throw new Error(`Vault key version ${kver} not found in keyring`)
    }
    return key
  }

  waitForKey(kver: string, timeoutMs: number = SYNC_TIMEOUTS.keyWait): Promise<boolean> {
    this.noteKeyVersion(kver)
    if (this.hasKey(kver)) {
      return Promise.resolve(true)
    }
    return new Promise(resolve => {
      const waiter: KeyVersionWaiter = {
        kver,
        resolve: (found: boolean) => {
          this.waiters.delete(waiter)
          clearTimeout(waiter.timer)
          resolve(found)
        },
        timer: setTimeout(() => {
          this.waiters.delete(waiter)
          resolve(false)
        }, timeoutMs),
      }
      this.waiters.add(waiter)
    })
  }

  /** Replaces every key at once, so no reader sees an empty keyring in between */
  replace(keys: Map<string, CryptoKey>, activeVersion: string): void {
    this.keys = new Map(keys)
    this.active = activeVersion
    this.noteVersions(keys, activeVersion)
    this.notifyWaiters()
  }

  /**
   * Adds keys to the ones already loaded. The active version only ever rises: the server could
   * replay an old keyring to bring a retired key back, so an older active version is ignored.
   * Returns whether the incoming keyring was stale (an older active version, or missing a key
   * already loaded here), so callers don't cache it in place of a newer one.
   */
  merge(keys: Map<string, CryptoKey>, activeVersion: string): { stale: boolean } {
    const current = this.keys.has(this.active) ? keyVersionNumber(this.active) : 0
    const missingKey = Array.from(this.keys.keys()).some(ver => !keys.has(ver))
    const stale = keyVersionNumber(activeVersion) < current || missingKey
    for (const [ver, key] of keys) {
      this.keys.set(ver, key)
    }
    if (keyVersionNumber(activeVersion) >= current) {
      this.active = activeVersion
    }
    this.noteVersions(keys, activeVersion)
    this.notifyWaiters()
    return { stale }
  }

  addKey(kver: string, key: CryptoKey): void {
    this.keys.set(kver, key)
    this.notifyWaiters()
  }

  removeKey(kver: string): void {
    this.keys.delete(kver)
  }

  setActiveVersion(kver: string): void {
    this.active = kver
    this.notifyWaiters()
  }

  /** Forgets which versions are known and whether v1 is password-derived, as for another account */
  forgetVersionHistory(): void {
    this.known = 0
    this.v1PasswordDerived = false
    this.warnedStaleVersions.clear()
  }

  /** Forgets every key. Pending waits resolve as not found. */
  clear(): void {
    this.keys.clear()
    this.active = '1'
    this.forgetVersionHistory()
    for (const waiter of Array.from(this.waiters)) {
      waiter.resolve(false)
    }
  }

  /** Exports every key, recording `activeVersion` (the current one by default) as active */
  async export(activeVersion = this.active): Promise<ExportedKeyring> {
    const exported: ExportedKeyring = { activeVersion }
    for (const [ver, key] of this.keys) {
      exported[ver] = await exportVaultKey(key)
    }
    return exported
  }

  /**
   * Exports every key plus the highest version this realm knows of, as the JSON `load` reads in
   * another realm. Never stored or sent to the server: its keyrings are written by `export`.
   */
  async exportForWorker(): Promise<string> {
    return JSON.stringify({ ...await this.export(), [KNOWN_VERSION_FIELD]: this.knownVersion })
  }

  /**
   * Loads a keyring exported by `export` or `exportForWorker` in another realm, replacing the keys
   * loaded here. The highest version the exporting realm knew of is kept.
   */
  async load(exportedJson: string): Promise<void> {
    const parsed = JSON.parse(exportedJson) as ExportedKeyring
    const { keys, activeVersion } = await importKeyring(parsed)
    if (keys.size === 0) {
      throw new Error('Keyring contains no key entries')
    }
    this.replace(keys, activeVersion)
    this.noteKeyVersion(parsed[KNOWN_VERSION_FIELD])
  }

  async encrypt(plaintext: string): Promise<CryptoResult> {
    this.assertActiveUsable()
    return encryptWithKey(this.getKey(), plaintext, this.active)
  }

  async decrypt(data: CryptoResult): Promise<string> {
    this.noteKeyVersion(data.kver)
    return decryptWithKey(this.getKey(data.kver || '1'), data)
  }

  async encryptBytes(bytes: Uint8Array, docId?: string, purpose?: DocBindingPurpose): Promise<CryptoResult> {
    this.assertActiveUsable()
    return encryptBytesWithKey(this.getKey(), bytes, this.active, docId, purpose)
  }

  async decryptBytes(data: CryptoResult, docId?: string, purpose?: DocBindingPurpose): Promise<Uint8Array> {
    this.noteKeyVersion(data.kver)
    return decryptBytesWithKey(this.getKey(data.kver || '1'), data, docId, purpose)
  }

  async wrapLocalKey(raw: Uint8Array, associatedData: Uint8Array): Promise<LocalKeyWrap> {
    this.assertActiveUsable()
    const kver = this.active
    const { iv, ct } = await encryptWithAssociatedData(this.getKey(kver), raw, associatedData)
    return { kver, iv, ct }
  }

  async unwrapLocalKey(wrap: LocalKeyWrap, associatedData: Uint8Array): Promise<Uint8Array> {
    this.noteKeyVersion(wrap.kver)
    return decryptWithAssociatedData(this.getKey(wrap.kver), wrap, associatedData)
  }

  /**
   * Refuses to encrypt with a password-derived v1 once a newer key is known to exist, since data
   * written with it could be attacked by guessing the password. On other accounts a stale keyring
   * only warns: its active key is still random.
   */
  private assertActiveUsable(): void {
    if (!this.isStale) return
    if (this.active === '1' && this.v1PasswordDerived) {
      throw new StaleKeyringError(this.knownVersion)
    }
    if (!this.warnedStaleVersions.has(this.known)) {
      this.warnedStaleVersions.add(this.known)
      log.warn(`Encrypting with key version ${this.active} although version ${this.knownVersion} exists`)
    }
  }

  private noteVersions(keys: Map<string, CryptoKey>, activeVersion: string): void {
    this.noteKeyVersion(activeVersion)
    for (const ver of keys.keys()) {
      this.noteKeyVersion(ver)
    }
  }

  private notifyWaiters(): void {
    for (const waiter of Array.from(this.waiters)) {
      if (this.hasKey(waiter.kver)) {
        waiter.resolve(true)
      }
    }
  }
}
