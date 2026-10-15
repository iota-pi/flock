import type { CryptoResult } from '../../../api/vault/crypto'
import type { KeyProvider } from '../../../api/vault/Keyring'

export class MissingKeyError extends Error {
  readonly kver: string

  constructor(kver: string, message?: string) {
    super(message ?? `Key version ${kver} not available`)
    this.name = 'MissingKeyError'
    this.kver = kver
  }
}

export interface DecryptKeyResolutionOptions {
  /** The document the ciphertext belongs to. Required to decrypt doc-bound ciphertexts. */
  docId?: string
  timeoutMs?: number
  onKeyVersionMissing?: (kver: string) => void
  timedOutKeys?: Set<string>
  skipWait?: boolean | ((kver: string) => boolean)
}

export async function decryptWithKeyResolution(
  keys: KeyProvider,
  payload: CryptoResult,
  options?: DecryptKeyResolutionOptions,
): Promise<Uint8Array> {
  const resolvedKver = payload.kver || '1'
  const timeoutMs = options?.timeoutMs ?? 5000

  if (!keys.hasKey(resolvedKver)) {
    const shouldSkip =
      options?.timedOutKeys?.has(resolvedKver) ||
      (typeof options?.skipWait === 'function' ? options.skipWait(resolvedKver) : Boolean(options?.skipWait))

    if (shouldSkip) {
      options?.timedOutKeys?.add(resolvedKver)
      throw new MissingKeyError(resolvedKver, `Key version ${resolvedKver} missing and wait skipped`)
    }

    options?.onKeyVersionMissing?.(resolvedKver)

    const keyAcquired = await keys.waitForKey(resolvedKver, timeoutMs)
    if (!keyAcquired && !keys.hasKey(resolvedKver)) {
      options?.timedOutKeys?.add(resolvedKver)
      throw new MissingKeyError(resolvedKver, `Timed out waiting for key version ${resolvedKver}`)
    }
  }

  return await keys.decryptBytes({ ...payload, kver: resolvedKver }, options?.docId)
}
