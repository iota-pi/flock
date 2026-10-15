import env from '../../env'
import { configureVaultEndpoint } from '../../api/vaultTrpcClient'
import { configureVaultHost } from '../../api/vault'
import { configureVaultStorageNames } from '../../sync/shared/storageNames'
import { useAppStore } from '../../state/store'
import { FLOCK_STORAGE_NAMES } from './storageNames'
import { handleClientOutdated } from './clientOutdated'
import { decodeLegacySalt } from './legacy/keyDerivation'

// Configures the vault on the main thread. Imported first by src/index.tsx so it runs before any vault code.
configureVaultStorageNames(FLOCK_STORAGE_NAMES)
configureVaultEndpoint(env.VAULT_ENDPOINT)
configureVaultHost({
  getAccountId: () => useAppStore.getState().account || undefined,
  onSessionLost: message => {
    useAppStore.getState().setSyncStatus('offline')
    useAppStore.getState().setSyncWarning(message)
  },
  onClientOutdated: () => {
    void handleClientOutdated({ showWarning: message => useAppStore.getState().setSyncWarning(message) })
  },
  decodeLegacySalt,
})
