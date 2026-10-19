import type { LocalKeyWrap, LocalKeyWrapper } from '../../../api/Keyring'
import { decryptWithAssociatedData, encryptWithAssociatedData } from '../../../api/crypto'

/** Where a sealed record lives. Each is bound into its associated data, so records can't be swapped. */
export type LocalContext =
  | { store: 'automerge', key: readonly string[] }
  | { store: 'wal', entryId: string, itemId: string }
  | { store: 'index' }

/** A record sealed with the device storage key */
export interface SealedRecord {
  v: 1
  iv: Uint8Array
  ct: Uint8Array
}

const LOCAL_FORMAT_VERSION = 1
const DSK_LENGTH = 32

/** The data key the device storage key is wrapped with isn't loaded */
export class LocalKeyUnavailableError extends Error {
  constructor(readonly kver?: string, options?: ErrorOptions) {
    super(kver
      ? `The key (version ${kver}) that protects this device's local data is not loaded`
      : "This device's local data has no key to open it with", options)
    this.name = 'LocalKeyUnavailableError'
  }
}

/** The device storage key, or the index it protects, failed to verify */
export class LocalDataUnreadableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'LocalDataUnreadableError'
  }
}

/** A sealed record failed to verify */
export class LocalDecryptionError extends Error {
  constructor(readonly context: LocalContext, options?: ErrorOptions) {
    super(`A ${context.store} record in local storage could not be decrypted`, options)
    this.name = 'LocalDecryptionError'
  }
}

function encodeAssociatedData(parts: readonly (string | number)[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(['vault-local', LOCAL_FORMAT_VERSION, ...parts]))
}

function dskAssociatedData(accountId: string): Uint8Array {
  return encodeAssociatedData(['dsk', accountId])
}

function contextParts(accountId: string, context: LocalContext): (string | number)[] {
  switch (context.store) {
    case 'automerge':
      return ['automerge', accountId, ...context.key]
    case 'wal':
      return ['wal', accountId, context.entryId, context.itemId]
    case 'index':
      return ['index', accountId]
  }
}

function isBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array
}

function isLocalKeyWrap(value: unknown): value is LocalKeyWrap {
  if (!value || typeof value !== 'object') return false
  const wrap = value as Partial<LocalKeyWrap>
  return typeof wrap.kver === 'string' && isBytes(wrap.iv) && isBytes(wrap.ct)
}

/** Decrypts a wrap's raw key bytes. The caller zeroes them. */
async function unwrapRaw(wrap: unknown, keys: LocalKeyWrapper, accountId: string): Promise<Uint8Array> {
  if (!isLocalKeyWrap(wrap)) {
    throw new LocalDataUnreadableError("This device's local storage key is malformed")
  }
  if (!keys.hasKey(wrap.kver)) {
    throw new LocalKeyUnavailableError(wrap.kver)
  }
  let raw: Uint8Array
  try {
    raw = await keys.unwrapLocalKey(wrap, dskAssociatedData(accountId))
  } catch (error) {
    throw new LocalDataUnreadableError("This device's local storage key could not be decrypted", { cause: error })
  }
  if (raw.byteLength !== DSK_LENGTH) {
    raw.fill(0)
    throw new LocalDataUnreadableError("This device's local storage key has the wrong length")
  }
  return raw
}

/** Imports raw key bytes as a non-extractable AES-GCM key, then zeroes them */
async function importDeviceKey(raw: Uint8Array): Promise<CryptoKey> {
  const buffer = new Uint8Array(raw.byteLength)
  buffer.set(raw)
  raw.fill(0)
  try {
    return await crypto.subtle.importKey('raw', buffer, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  } finally {
    buffer.fill(0)
  }
}

/**
 * Seals and opens local records with this device's storage key (DSK), a random AES-GCM-256 key per
 * account. The DSK is stored wrapped with a data key, so password changes leave it untouched (see
 * "Part 2: local encryption" in docs/local-encryption.md).
 */
export class LocalCipher {
  private constructor(
    private readonly key: CryptoKey,
    readonly accountId: string,
  ) {}

  /** Generates a DSK, wrapped with the active data key */
  static async create(keys: LocalKeyWrapper, accountId: string): Promise<{ cipher: LocalCipher, wrap: LocalKeyWrap }> {
    const raw = crypto.getRandomValues(new Uint8Array(DSK_LENGTH))
    let wrap: LocalKeyWrap
    try {
      wrap = await keys.wrapLocalKey(raw, dskAssociatedData(accountId))
    } catch (error) {
      raw.fill(0)
      throw error
    }
    return { cipher: new LocalCipher(await importDeviceKey(raw), accountId), wrap }
  }

  /** Opens a stored DSK wrap with the data key it names */
  static async unwrap(wrap: unknown, keys: LocalKeyWrapper, accountId: string): Promise<LocalCipher> {
    const raw = await unwrapRaw(wrap, keys, accountId)
    return new LocalCipher(await importDeviceKey(raw), accountId)
  }

  /**
   * Wraps the same DSK with the active data key. Returns null when it already is. The DSK in memory
   * is non-extractable, so this decrypts the stored wrap again.
   */
  static async rewrap(wrap: unknown, keys: LocalKeyWrapper, accountId: string): Promise<LocalKeyWrap | null> {
    if (isLocalKeyWrap(wrap) && wrap.kver === keys.activeVersion) return null
    const raw = await unwrapRaw(wrap, keys, accountId)
    try {
      return await keys.wrapLocalKey(raw, dskAssociatedData(accountId))
    } finally {
      raw.fill(0)
    }
  }

  async seal(context: LocalContext, bytes: Uint8Array): Promise<SealedRecord> {
    const { iv, ct } = await encryptWithAssociatedData(this.key, bytes, this.associatedData(context))
    return { v: LOCAL_FORMAT_VERSION, iv, ct }
  }

  /** Opens a sealed record. Throws `LocalDecryptionError` unless it verifies for exactly this context. */
  async open(context: LocalContext, record: unknown): Promise<Uint8Array> {
    const sealed = record as Partial<SealedRecord> | null
    if (!sealed || sealed.v !== LOCAL_FORMAT_VERSION || !isBytes(sealed.iv) || !isBytes(sealed.ct)) {
      throw new LocalDecryptionError(context)
    }
    try {
      return await decryptWithAssociatedData(this.key, { iv: sealed.iv, ct: sealed.ct }, this.associatedData(context))
    } catch (error) {
      throw new LocalDecryptionError(context, { cause: error })
    }
  }

  private associatedData(context: LocalContext): Uint8Array {
    return encodeAssociatedData(contextParts(this.accountId, context))
  }
}
