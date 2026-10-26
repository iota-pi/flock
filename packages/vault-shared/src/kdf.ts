import type { KdfParams } from './crypto'

/** How salts are encoded for new passwords: base64 of 16 random bytes */
export const CURRENT_SALT_VERSION = 1

let testKeyDerivation = false

/**
 * Makes this realm run the real derivation with parameters cheap enough for tests, and accept
 * them when they're read back. Call it before any key is derived, and never in production.
 */
export function enableTestKeyDerivation(): void {
  testKeyDerivation = true
}

/** Whether `enableTestKeyDerivation` has been called in this realm */
export function isTestKeyDerivation(): boolean {
  return testKeyDerivation
}

const PRODUCTION_KDF: KdfParams = { algorithm: 'argon2id', memoryKiB: 64 * 1024, passes: 3, parallelism: 1 }
export const TEST_KDF: KdfParams = { algorithm: 'argon2id', memoryKiB: 8, passes: 1, parallelism: 1 }

/** The Argon2id parameters new passwords are derived with */
export function getDefaultKdf(): KdfParams {
  return testKeyDerivation ? TEST_KDF : PRODUCTION_KDF
}
