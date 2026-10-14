import { createHash, timingSafeEqual } from 'crypto'

export function safeEqual(attempt: string, real: string) {
  if (attempt.length !== real.length) {
    return false
  }

  return timingSafeEqual(Buffer.from(attempt), Buffer.from(real))
}

export function generateAccountId() {
  return Math.random().toString(36).substring(2, 6)
}

export function hashString(input: string): string {
  return createHash('sha512').update(input).digest('base64')
}
