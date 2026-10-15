import env from '../env'
import { configureVaultEndpoint, configureVaultHost, getTrackedFetch, initVaultTrpcClient } from '@vault/client'
import { configureVaultStorageNames } from '@vault/client/storageNames'
import { FLOCK_STORAGE_NAMES } from '../app/vault/storageNames'
import { decodeLegacySalt } from './legacy/keyDerivation'

// Configures the vault for the migration app. Imported first by main.tsx so it runs before any vault code.
configureVaultStorageNames(FLOCK_STORAGE_NAMES)
configureVaultEndpoint(env.VAULT_ENDPOINT)
configureVaultHost({ decodeLegacySalt })
initVaultTrpcClient(getTrackedFetch(() => {}, () => {}))
