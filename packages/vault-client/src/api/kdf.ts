import * as Comlink from 'comlink'
import type { KdfParams } from '@vault/shared'
import { createLogger } from '../sync/utils/logger'

const log = createLogger('kdf')

export type { KdfParams }

let testKeyDerivation = false

/**
 * Makes this realm run the real derivation with parameters cheap enough for tests, and accept
 * them when they're read back. Call it before any key is derived, and never in production.
 */
export function enableTestKeyDerivation(): void {
  testKeyDerivation = true
}

const PRODUCTION_KDF: KdfParams = { algorithm: 'argon2id', memoryKiB: 64 * 1024, passes: 3, parallelism: 1 }
const TEST_KDF: KdfParams = { algorithm: 'argon2id', memoryKiB: 8, passes: 1, parallelism: 1 }

/** The Argon2id parameters new passwords are derived with */
export function getDefaultKdf(): KdfParams {
  return testKeyDerivation ? TEST_KDF : PRODUCTION_KDF
}

/** The PBKDF2 iterations for a key derivation that doesn't say how many it used */
export function getDefaultPbkdf2Iterations(): number {
  return testKeyDerivation ? 1 : 600_000
}

/** The PBKDF2 iterations of accounts from before the count was stored */
export function getLegacyPbkdf2Iterations(): number {
  return testKeyDerivation ? 1 : 100_000
}

export interface KdfLimits {
  /** The weakest Argon2id parameters any release has written. Weaker ones are refused. */
  argon2idFloor: Omit<KdfParams, 'algorithm'>
  /** The most a login will spend, so an altered account record can't exhaust the device */
  argon2idCeiling: Omit<KdfParams, 'algorithm'>
  /** The fewest PBKDF2 iterations any release has written */
  pbkdf2MinIterations: number
}

export const PRODUCTION_KDF_LIMITS: KdfLimits = {
  argon2idFloor: { memoryKiB: 64 * 1024, passes: 3, parallelism: 1 },
  argon2idCeiling: { memoryKiB: 256 * 1024, passes: 10, parallelism: 4 },
  pbkdf2MinIterations: 100_000,
}

const TEST_KDF_LIMITS: KdfLimits = {
  argon2idFloor: { memoryKiB: TEST_KDF.memoryKiB, passes: 1, parallelism: 1 },
  argon2idCeiling: PRODUCTION_KDF_LIMITS.argon2idCeiling,
  pbkdf2MinIterations: 1,
}

/** The limits key derivation parameters are checked against when they're read back */
export function getKdfLimits(): KdfLimits {
  return testKeyDerivation ? TEST_KDF_LIMITS : PRODUCTION_KDF_LIMITS
}

export class UnsupportedKeyDerivationError extends Error {
  /** Takes a reason, or the unsupported salt version */
  constructor(reason: string | number | undefined) {
    super(typeof reason === 'string' ? reason : `Unsupported salt version: ${reason ?? 'none'}`)
    this.name = 'UnsupportedKeyDerivationError'
  }
}

/**
 * Checks Argon2id parameters read from the server or local metadata. The client chooses them, but
 * reads them back from the server, so an altered account record could otherwise make a login
 * derive a key that is cheap to guess from its auth token, or one too expensive to finish.
 */
export function assertKdfAcceptable(kdf: KdfParams, limits: KdfLimits = getKdfLimits()): void {
  if (kdf.algorithm !== 'argon2id') {
    throw new UnsupportedKeyDerivationError(`Unsupported key derivation algorithm: ${String(kdf.algorithm)}`)
  }
  for (const parameter of ['memoryKiB', 'passes', 'parallelism'] as const) {
    const value = kdf[parameter]
    if (!Number.isInteger(value) || value < limits.argon2idFloor[parameter]) {
      throw new UnsupportedKeyDerivationError(`Key derivation ${parameter} is below the minimum: ${value}`)
    }
    if (value > limits.argon2idCeiling[parameter]) {
      throw new UnsupportedKeyDerivationError(`Key derivation ${parameter} is above the maximum: ${value}`)
    }
  }
}

/** Checks a PBKDF2 iteration count read from the server or local metadata, as `assertKdfAcceptable` does */
export function assertPbkdf2Acceptable(iterations: number, limits: KdfLimits = getKdfLimits()): void {
  if (!Number.isInteger(iterations) || iterations < limits.pbkdf2MinIterations) {
    throw new UnsupportedKeyDerivationError(`PBKDF2 iterations are below the minimum: ${iterations}`)
  }
}

/** Runs Argon2id in this realm. The KDF worker calls it; elsewhere use `deriveArgon2idBytes`. */
export async function computeArgon2id(password: string, salt: Uint8Array, kdf: KdfParams): Promise<Uint8Array> {
  const { argon2id } = await import('hash-wasm')
  return argon2id({
    password,
    salt,
    iterations: kdf.passes,
    parallelism: kdf.parallelism,
    memorySize: kdf.memoryKiB,
    hashLength: 32,
    outputType: 'binary',
  })
}

/** What `exposeKdfWorker` serves */
export interface KdfWorkerApi {
  deriveArgon2id(password: string, salt: Uint8Array, kdf: KdfParams): Promise<Uint8Array>
}

let createKdfWorker: (() => Worker) | undefined

/** Set by `configureVaultHost`. Without a factory, Argon2id runs in the calling realm. */
export function setKdfWorkerFactory(factory: (() => Worker) | undefined): void {
  createKdfWorker = factory
}

/**
 * How long a KDF worker may take before the derivation is given up there. Far beyond a slow phone's
 * time for the defaults, so it only catches a worker that will never answer.
 */
export const KDF_WORKER_TIMEOUT_MS = 60_000

/**
 * Derives 32 bytes with Argon2id. With a KDF worker configured, it runs in a fresh worker, so the
 * page stays responsive and the memory is released when the worker is terminated. If the worker
 * can't be created, fails to load or never answers, it runs in this realm instead: a page that
 * freezes for a moment beats a login that never finishes.
 */
export async function deriveArgon2idBytes(password: string, salt: Uint8Array, kdf: KdfParams): Promise<Uint8Array> {
  if (!createKdfWorker) {
    return computeArgon2id(password, salt, kdf)
  }
  let worker: Worker
  try {
    worker = createKdfWorker()
  } catch (err) {
    log.warn('Could not start the key derivation worker; deriving here instead:', err)
    return computeArgon2id(password, salt, kdf)
  }
  try {
    return await deriveInWorker(worker, password, salt, kdf)
  } catch (err) {
    log.warn('The key derivation worker failed; deriving here instead:', err)
    return computeArgon2id(password, salt, kdf)
  } finally {
    worker.terminate()
  }
}

/** Runs one derivation in `worker`, failing on a worker error or after `KDF_WORKER_TIMEOUT_MS` */
function deriveInWorker(worker: Worker, password: string, salt: Uint8Array, kdf: KdfParams): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    // Comlink doesn't see a worker that fails to load or evaluate, so its call would never settle
    const onWorkerError = () => settle(() => reject(new Error('The key derivation worker failed')))
    const timer = setTimeout(
      () => settle(() => reject(new Error('The key derivation worker did not answer'))),
      KDF_WORKER_TIMEOUT_MS,
    )
    function settle(finish: () => void) {
      clearTimeout(timer)
      worker.removeEventListener('error', onWorkerError)
      worker.removeEventListener('messageerror', onWorkerError)
      finish()
    }
    worker.addEventListener('error', onWorkerError)
    worker.addEventListener('messageerror', onWorkerError)

    Comlink.wrap<KdfWorkerApi>(worker).deriveArgon2id(password, salt, kdf).then(
      bytes => settle(() => resolve(bytes)),
      (err: unknown) => settle(() => reject(err)),
    )
  })
}
