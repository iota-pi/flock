import crypto from 'node:crypto'
import { configureVaultStorageNames, createVaultStorageNames } from '../src/sync/shared/storageNames'

globalThis.isSecureContext = true

// Library tests use their own names, so nothing depends on an app's
configureVaultStorageNames(createVaultStorageNames('test'))

if (typeof globalThis.crypto === 'undefined') {
  Object.defineProperty(globalThis, 'crypto', {
    value: crypto.webcrypto as Crypto,
    writable: false,
    configurable: true,
  })
}

await import('@automerge/automerge')
