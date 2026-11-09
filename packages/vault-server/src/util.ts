import { createHash, createHmac, randomInt, timingSafeEqual } from 'crypto'
import { ACCOUNT_ID_ALPHABET, ACCOUNT_ID_LENGTH } from '@vault/shared'

export function safeEqual(attempt: string, real: string) {
  if (attempt.length !== real.length) {
    return false
  }

  return timingSafeEqual(Buffer.from(attempt), Buffer.from(real))
}

/** A random account ID in the canonical form (`@vault/shared`'s `accountId.ts`) */
export function generateAccountId(length = ACCOUNT_ID_LENGTH): string {
  return Array.from(
    { length },
    () => ACCOUNT_ID_ALPHABET[randomInt(ACCOUNT_ID_ALPHABET.length)],
  ).join('')
}

/** A salt for an account that doesn't exist, shaped like the 16 random bytes clients generate */
export function fakeSalt(account: string, secret: string): string {
  return createHmac('sha256', secret).update(account).digest().subarray(0, 16).toString('base64')
}

export function hashString(input: string): string {
  return createHash('sha512').update(input).digest('base64')
}
