import crypto from 'node:crypto'
import { configureVaultStorageNames, createVaultStorageNames } from '../src/sync/shared/storageNames'
import { enableTestKeyDerivation } from '../src/api/kdf'
import { clearAccountStoreInstancesCacheForTesting } from '../src/sync/shared/createAccountStore'
import { clearQuotaRecoveryHandlerForTesting, resetQuotaExceededStatus } from '../src/sync/utils/storageManager'

// Packages that specs spy on (see moduleMocks.ts). Test files share module state, so these
// mocks are the only module mocks: specs use `vi.spyOn` instead of `vi.mock`.
vi.mock('@automerge/automerge/slim', async () => (await import('./moduleMocks')).mutableCopy('@automerge/automerge/slim'))
vi.mock('@automerge/automerge-repo/slim', async () => (await import('./moduleMocks')).mutableCopy('@automerge/automerge-repo/slim'))
vi.mock('@automerge/automerge-repo-network-broadcastchannel', async () => (await import('./moduleMocks')).mutableCopy('@automerge/automerge-repo-network-broadcastchannel'))
vi.mock('comlink', async () => (await import('./moduleMocks')).mutableCopy('comlink'))

globalThis.isSecureContext = true

// Library tests use their own names, so nothing depends on an app's
configureVaultStorageNames(createVaultStorageNames('test'))
enableTestKeyDerivation()

if (typeof globalThis.crypto === 'undefined') {
  Object.defineProperty(globalThis, 'crypto', {
    value: crypto.webcrypto as Crypto,
    writable: false,
    configurable: true,
  })
}

await import('@automerge/automerge')

// Test files share each worker (`isolate: false`), and this file runs before each one
localStorage.clear()
sessionStorage.clear()

// Specs mock localforage per test with
// `vi.spyOn(localforage, 'createInstance')`, so cached instances must not outlive a test.
beforeEach(() => {
  clearAccountStoreInstancesCacheForTesting()
  clearQuotaRecoveryHandlerForTesting()
  resetQuotaExceededStatus()
})
