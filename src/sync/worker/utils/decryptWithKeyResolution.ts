import { decryptBytes, hasVaultKey, waitForKeyVersion, type CryptoResult } from 'src/api/vault'

export class MissingKeyError extends Error {
  readonly kver: string

  constructor(kver: string, message?: string) {
    super(message ?? `Key version ${kver} not available`)
    this.name = 'MissingKeyError'
    this.kver = kver
  }
}

export interface DecryptKeyResolutionOptions {
  timeoutMs?: number
  onKeyVersionMissing?: (kver: string) => void
  timedOutKeys?: Set<string>
  skipWait?: boolean | ((kver: string) => boolean)
}

export async function decryptWithKeyResolution(
  payload: CryptoResult,
  options?: DecryptKeyResolutionOptions,
): Promise<Uint8Array>
export async function decryptWithKeyResolution(
  cipher: string,
  iv: string,
  kver?: string,
  options?: DecryptKeyResolutionOptions,
): Promise<Uint8Array>
export async function decryptWithKeyResolution(
  arg1: CryptoResult | string,
  arg2?: DecryptKeyResolutionOptions | string,
  arg3?: string,
  arg4?: DecryptKeyResolutionOptions,
): Promise<Uint8Array> {
  let cipher: string
  let iv: string
  let kver: string | undefined
  let options: DecryptKeyResolutionOptions | undefined

  if (typeof arg1 === 'object' && arg1 !== null) {
    cipher = arg1.cipher
    iv = arg1.iv
    kver = arg1.kver
    options = arg2 as DecryptKeyResolutionOptions | undefined
  } else {
    cipher = arg1
    iv = arg2 as string
    kver = arg3
    options = arg4
  }

  const resolvedKver = kver || '1'
  const timeoutMs = options?.timeoutMs ?? 5000

  if (!hasVaultKey(resolvedKver)) {
    const shouldSkip =
      options?.timedOutKeys?.has(resolvedKver) ||
      (typeof options?.skipWait === 'function' ? options.skipWait(resolvedKver) : Boolean(options?.skipWait))

    if (shouldSkip) {
      options?.timedOutKeys?.add(resolvedKver)
      throw new MissingKeyError(resolvedKver, `Key version ${resolvedKver} missing and wait skipped`)
    }

    options?.onKeyVersionMissing?.(resolvedKver)

    const keyAcquired = await waitForKeyVersion(resolvedKver, timeoutMs)
    if (!keyAcquired && !hasVaultKey(resolvedKver)) {
      options?.timedOutKeys?.add(resolvedKver)
      throw new MissingKeyError(resolvedKver, `Timed out waiting for key version ${resolvedKver}`)
    }
  }

  try {
    const payload: CryptoResult =
      typeof arg1 === 'object' && arg1 !== null
        ? { ...arg1, kver: resolvedKver }
        : { cipher, iv, kver: resolvedKver }
    return await decryptBytes(payload)
  } catch (error: any) {
    if (
      !hasVaultKey(resolvedKver) ||
      (typeof error?.message === 'string' && error.message.includes('not found in keyring'))
    ) {
      options?.timedOutKeys?.add(resolvedKver)
      throw new MissingKeyError(resolvedKver, `Key version ${resolvedKver} not found in keyring`)
    }
    throw error
  }
}
