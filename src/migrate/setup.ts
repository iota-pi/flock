import env from '../env'
import {
  configureVaultEndpoint,
  configureVaultHost,
  getTrackedFetch,
  initVaultTrpcClient,
} from '@vault/client'
import { configureVaultStorageNames } from '@vault/client/storageNames'
import { enableTestKeyDerivation } from '@vault/shared'
import { FLOCK_STORAGE_NAMES } from '../app/vault/storageNames'
import { failCypressTestOnRequestError, isCypress } from '../app/vault/cypress'
import { decodeLegacySalt, deriveLegacyKey } from './legacy/keyDerivation'

// Configures the vault for the migration app. Imported first by main.tsx so it runs before any vault code.
configureVaultStorageNames(FLOCK_STORAGE_NAMES)
if (isCypress) enableTestKeyDerivation()
configureVaultEndpoint(env.VAULT_ENDPOINT)
configureVaultHost({
  decodeLegacySalt,
  deriveLegacyKey,
  createKdfWorker: typeof Worker === 'undefined'
    ? undefined
    : () => new Worker(new URL('../app/vault/kdf.worker.ts', import.meta.url), { type: 'module' }),
})
initVaultTrpcClient(getTrackedFetch(() => {}, () => {}, isCypress ? failCypressTestOnRequestError : undefined))
