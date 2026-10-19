import env from '../../env'
import { configureVaultEndpoint, configureVaultHost } from '@vault/client'
import { configureVaultStorageNames } from '@vault/client/storageNames'
import { useAppStore } from '../../state/store'
import { FLOCK_STORAGE_NAMES } from './storageNames'
import { handleClientOutdated } from './clientOutdated'
import { MIGRATION_CHANNEL, type MigrationChannelMessage } from '../../migrate/detection'
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
  createKdfWorker: typeof Worker === 'undefined'
    ? undefined
    : () => new Worker(new URL('./kdf.worker.ts', import.meta.url), { type: 'module' }),
})

// The migration app runs the only engine while it works, so this tab steps aside
const migrationChannel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(MIGRATION_CHANNEL)
if (migrationChannel) {
  migrationChannel.onmessage = event => {
    void handleMigrationMessage(event.data)
  }
}

/**
 * Asks the main app's other tabs to lock, as the migration app does. Posted on the channel this tab
 * listens with, which never delivers a message to the channel that sent it, so this tab carries on.
 */
export function askOtherTabsToStop(message: MigrationChannelMessage): void {
  migrationChannel?.postMessage(message)
}
