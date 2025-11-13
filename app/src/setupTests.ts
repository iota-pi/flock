import { vi } from 'vitest'
import crypto from 'node:crypto'

vi.mock('./env', () => ({
  default: {
    PUBLIC_URL: '',
    VAPID_PUBLIC_KEY: '',
    VAULT_ENDPOINT: '',
  },
}))

globalThis.isSecureContext = true
globalThis.crypto = globalThis.window.crypto = crypto.webcrypto as Crypto
