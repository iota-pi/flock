import env from '../../env'
import { configureVaultEndpoint, configureVaultHost } from '@vault/client'
import { configureVaultStorageNames } from '@vault/client/storageNames'
import { useAppStore } from '../../state/store'
import { FLOCK_STORAGE_NAMES } from './storageNames'
import { handleClientOutdated } from './clientOutdated'
import { MIGRATION_CHANNEL } from '../../migrate/detection'
import { handleMigrationMessage } from './migrationTakeover'
import { forceAppUpdate } from '../appUpdate'

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
    void handleClientOutdated({
      showWarning: message => useAppStore.getState().setSyncWarning(message),
      applyUpdate: forceAppUpdate,
    })
  },
})

// The migration app runs the only engine while it works, so this tab steps aside
if (typeof BroadcastChannel !== 'undefined') {
  const migrationChannel = new BroadcastChannel(MIGRATION_CHANNEL)
  migrationChannel.onmessage = event => {
    void handleMigrationMessage(event.data)
  }
}
