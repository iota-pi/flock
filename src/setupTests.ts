import crypto from 'node:crypto'
import { configureVaultStorageNames } from '@vault/client/storageNames'
import { FLOCK_STORAGE_NAMES } from './app/vault/storageNames'


vi.mock('./env', () => ({
  default: {
    PUBLIC_URL: '',
    VAPID_PUBLIC_KEY: '',
    VAULT_ENDPOINT: '',
  },
}))

// Packages that specs spy on (see `mutableCopy`). Test files share module state, so these and
// `./env` are the only module mocks: specs use `vi.spyOn` instead of `vi.mock`.
vi.mock('@sentry/react', async () => (await import('./utils/testUtils')).mutableCopy('@sentry/react'))
vi.mock('@sentry/node', async () => (await import('./utils/testUtils')).mutableCopy('@sentry/node'))
vi.mock('web-push', async () => (await import('./utils/testUtils')).mutableCopy('web-push'))
vi.mock('@zxcvbn-ts/core', async () => (await import('./utils/testUtils')).mutableCopy('@zxcvbn-ts/core'))

globalThis.isSecureContext = true

configureVaultStorageNames(FLOCK_STORAGE_NAMES)

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

// Ensure `DYNAMODB_ENDPOINT` is set when running tests locally from the host
// Default to the common DynamoDB Local address used by `docker compose`
if (!process.env.DYNAMODB_ENDPOINT) {
  process.env.DYNAMODB_ENDPOINT = 'http://127.0.0.1:8000'
}
// Table names used by the vault's DynamoDriver (created locally by `yarn initdb`)
process.env.ACCOUNTS_TABLE ??= 'FlockAccounts'
process.env.ITEMS_TABLE ??= 'FlockItems'
process.env.SYNC_MESSAGES_TABLE ??= 'FlockSyncMessages'

import '@automerge/automerge'

// Test files share each worker (`isolate: false`) and this file runs before each one, so reset
// what one file could leave behind for the next.
if (typeof window !== 'undefined') {
  const { cleanup } = await import('@testing-library/react')
  const { useAppStore } = await import('./state/store')

  // RTL registers its own cleanup only in the first file that loads it in a worker
  afterEach(() => {
    cleanup()
  })

  localStorage.clear()
  sessionStorage.clear()
  useAppStore.setState(useAppStore.getInitialState(), true)
}
