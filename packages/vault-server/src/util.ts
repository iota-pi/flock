import { createHash, createHmac, randomInt, timingSafeEqual } from 'crypto'

export function safeEqual(attempt: string, real: string) {
  if (attempt.length !== real.length) {
    return false
  }

  return timingSafeEqual(Buffer.from(attempt), Buffer.from(real))
}

const ACCOUNT_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
const ACCOUNT_ID_LENGTH = 4

export function generateAccountId() {
  return Array.from(
    { length: ACCOUNT_ID_LENGTH },
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
