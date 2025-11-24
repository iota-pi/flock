import crypto from 'node:crypto'

vi.mock('./env', () => ({
  default: {
    PUBLIC_URL: '',
    VAPID_PUBLIC_KEY: '',
    VAULT_ENDPOINT: '',
  },
}))

globalThis.isSecureContext = true

// Some test environments (jsdom/vitest) already provide a read-only `crypto` accessor.
// Assign only if absent, and use Object.defineProperty in a try/catch to avoid
// "only a getter" or non-configurable property errors.
try {
  if (typeof (globalThis as any).crypto === 'undefined') {
    Object.defineProperty(globalThis, 'crypto', {
      value: crypto.webcrypto as Crypto,
      writable: false,
      configurable: true,
    })
  }
} catch (err) {
  // If assignment fails, assume environment provides a compatible crypto implementation.
  // Swallow the error to avoid failing test setup.
}

// Ensure TextEncoder/TextDecoder are available in Node test environments.
// Use top-level await to import Node's util.TextEncoder/TextDecoder when needed.
const enc: typeof TextEncoder = (globalThis as any).TextEncoder || (await import('util')).TextEncoder
const dec: typeof TextDecoder = (globalThis as any).TextDecoder || (await import('util')).TextDecoder
if (typeof (globalThis as any).TextEncoder === 'undefined') {
  Object.defineProperty(globalThis, 'TextEncoder', {
    value: enc,
    writable: false,
    configurable: true,
  })
}
if (typeof (globalThis as any).TextDecoder === 'undefined') {
  Object.defineProperty(globalThis, 'TextDecoder', {
    value: dec,
    writable: false,
    configurable: true,
  })
}
