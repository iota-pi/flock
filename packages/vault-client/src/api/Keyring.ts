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
} from './crypto'
import { SYNC_TIMEOUTS } from '../sync/shared/syncConfig'

/** The data keys the sync engine encrypts and decrypts with */
export interface KeyProvider {
  /** Whether the key with this version (or the active key) is loaded */
  hasKey(kver?: string): boolean
  /** Waits up to `timeoutMs` for the key with this version to be loaded. Returns whether it was. */
  waitForKey(kver: string, timeoutMs?: number): Promise<boolean>
  /** Encrypts with the active key. Pass the `docId` of the document the bytes belong to, to bind them to it. */
  encryptBytes(bytes: Uint8Array, docId?: string): Promise<CryptoResult>
  decryptBytes(data: CryptoResult, docId?: string): Promise<Uint8Array>
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

type KeyVersionWaiter = {
  kver: string
  resolve: (found: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

/** Key versions and their exported keys, plus `activeVersion` (the format `export` writes) */
export type ExportedKeyring = Record<string, string>

/** Parses a keyring written by `Keyring.export` */
export async function importKeyring(exported: ExportedKeyring): Promise<{
  keys: Map<string, CryptoKey>
  activeVersion: string
}> {
  if (!exported || typeof exported !== 'object' || !exported.activeVersion) {
    throw new Error('Not a structured keyring')
  }
  const entries = await Promise.all(
    Object.entries(exported)
      .filter(([ver]) => ver !== 'activeVersion')
      .map(async ([ver, expKey]) => [ver, await importVaultKey(expKey)] as const)
  )
  return { keys: new Map(entries), activeVersion: exported.activeVersion }
}

/** The account's data keys, by version, in one realm */
export class Keyring implements KeyProvider, LocalKeyWrapper {
  private keys = new Map<string, CryptoKey>()
  private active = '1'
  private waiters = new Set<KeyVersionWaiter>()

  get activeVersion(): string {
    return this.active
  }

  hasKey(kver?: string): boolean {
    return this.keys.has(kver || this.active)
  }

  /** Returns the key with this version, or the active key */
  getKey(kver?: string): CryptoKey {
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
    this.notifyWaiters()
  }

  /** Adds keys to the ones already loaded and switches the active version */
  merge(keys: Map<string, CryptoKey>, activeVersion: string): void {
    for (const [ver, key] of keys) {
      this.keys.set(ver, key)
    }
    this.active = activeVersion
    this.notifyWaiters()
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

  /** Forgets every key. Pending waits resolve as not found. */
  clear(): void {
    this.keys.clear()
    this.active = '1'
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
   * Loads a keyring exported by `export` in another realm (as JSON, as `exportKeyringData` sends it),
   * replacing the keys loaded here
   */
  async load(exportedJson: string): Promise<void> {
    const { keys, activeVersion } = await importKeyring(JSON.parse(exportedJson))
    if (keys.size === 0) {
      throw new Error('Keyring contains no key entries')
    }
    this.replace(keys, activeVersion)
  }

  async encrypt(plaintext: string): Promise<CryptoResult> {
    return encryptWithKey(this.getKey(), plaintext, this.active)
  }

  async decrypt(data: CryptoResult): Promise<string> {
    return decryptWithKey(this.getKey(data.kver || '1'), data)
  }

  async encryptBytes(bytes: Uint8Array, docId?: string): Promise<CryptoResult> {
    return encryptBytesWithKey(this.getKey(), bytes, this.active, docId)
  }

  async decryptBytes(data: CryptoResult, docId?: string): Promise<Uint8Array> {
    return decryptBytesWithKey(this.getKey(data.kver || '1'), data, docId)
  }

  async wrapLocalKey(raw: Uint8Array, associatedData: Uint8Array): Promise<LocalKeyWrap> {
    const kver = this.active
    const { iv, ct } = await encryptWithAssociatedData(this.getKey(kver), raw, associatedData)
    return { kver, iv, ct }
  }

  async unwrapLocalKey(wrap: LocalKeyWrap, associatedData: Uint8Array): Promise<Uint8Array> {
    return decryptWithAssociatedData(this.getKey(wrap.kver), wrap, associatedData)
  }

  private notifyWaiters(): void {
    for (const waiter of Array.from(this.waiters)) {
      if (this.hasKey(waiter.kver)) {
        waiter.resolve(true)
      }
    }
  }
}
