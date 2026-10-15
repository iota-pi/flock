import * as Sentry from '@sentry/react'
import { createSyncBridge } from '@vault/client'
import type { SyncStateSink, SyncTelemetry } from '@vault/client'
import { useAppStore } from '../../state/store'
import type { Item } from '../../state/items'
import type { AccountMetadata } from '../../state/metadata'
import { goToMigration } from '../../migrate/detection'

export const storeSink: SyncStateSink<Item, AccountMetadata> = {
  updateItems: updates => useAppStore.getState().updateItemsFromServer(updates),
  updateIndex: itemIds => useAppStore.getState().updateIndexFromServer(itemIds),
  updateMetadata: metadata => useAppStore.getState().updateMetadata(metadata),
  getSyncStatus: () => useAppStore.getState().syncStatus,
  setSyncStatus: status => useAppStore.getState().setSyncStatus(status),
  getSyncWarning: () => useAppStore.getState().syncWarning,
  setSyncWarning: message => useAppStore.getState().setSyncWarning(message),
  clearSyncWarning: () => useAppStore.getState().clearSyncWarning(),
  setFatalError: message => useAppStore.getState().setFatalError(message),
  setQuotaExceeded: exceeded => useAppStore.getState().setQuotaExceeded(exceeded),
  setLeaderConflict: hasConflict => useAppStore.getState().setLeaderConflict(hasConflict),
  startRequest: () => useAppStore.getState().startRequest(),
  finishRequest: () => useAppStore.getState().finishRequest(),
  reset: () => useAppStore.getState().reset(),
  onDataRestored: () => useAppStore.getState().incrementGeneration(),
  onMigrationRequired: () => {
    const { account } = useAppStore.getState()
    void (async () => {
      const { lockVault } = await import('./session')
      await lockVault()
      goToMigration(account)
    })()
  },
}

const sentryTelemetry: SyncTelemetry = {
  setUser: id => Sentry.setUser(id ? { id } : null),
  setTag: (key, value) => Sentry.setTag(key, value),
  addBreadcrumb: breadcrumb => Sentry.addBreadcrumb(breadcrumb),
  captureException: (error, tags) => {
    Sentry.captureException(error, tags ? { tags } : undefined)
  },
}

export const SyncBridge = createSyncBridge<Item, AccountMetadata>({
  createWorker: () => new Worker(new URL('./vault.worker.ts', import.meta.url), { type: 'module' }),
  sink: storeSink,
  telemetry: sentryTelemetry,
  getAccountId: () => useAppStore.getState().account,
  lockVault: async () => {
    // Imported lazily because session.ts depends on this module
    const { lockVault } = await import('./session')
    await lockVault()
  },
})
