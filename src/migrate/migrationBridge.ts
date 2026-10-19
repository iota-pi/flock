import * as Sentry from '@sentry/react'
import { createSyncBridge, lockVaultKeys } from '@vault/client'
import type { SyncStateSink, SyncStatus, SyncTelemetry } from '@vault/client'
import { MIGRATION_CHANNEL, type MigrationChannelMessage } from './detection'

export interface MigrationSyncState {
  status: SyncStatus
  warning: string | null
  fatalError: string | null
}

const initialState: MigrationSyncState = { status: 'connecting', warning: null, fatalError: null }

let state = initialState
let account = ''
const listeners = new Set<() => void>()

function setState(changes: Partial<MigrationSyncState>) {
  state = { ...state, ...changes }
  for (const listener of listeners) {
    listener()
  }
}

/** For `useSyncExternalStore` */
export function subscribeSyncState(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getSyncState(): MigrationSyncState {
  return state
}

export function setMigrationAccount(next: string): void {
  account = next
}

// The migration app shows no items, so it only keeps the sync status
const sink: SyncStateSink = {
  updateItems: () => {},
  updateIndex: () => {},
  updateMetadata: () => {},
  getSyncStatus: () => state.status,
  setSyncStatus: status => setState({ status }),
  getSyncWarning: () => state.warning,
  setSyncWarning: warning => setState({ warning }),
  clearSyncWarning: () => setState({ warning: null }),
  setFatalError: fatalError => setState({ fatalError }),
  setQuotaExceeded: () => {},
  setLeaderConflict: () => {},
  startRequest: () => {},
  finishRequest: () => {},
  reset: () => setState(initialState),
  beforeRetiringLegacyStores: accountId => {
    if (typeof BroadcastChannel === 'undefined') return
    // This page doesn't listen on the channel, so it can post from a channel of its own
    const channel = new BroadcastChannel(MIGRATION_CHANNEL)
    channel.postMessage({ type: 'started', account: accountId } satisfies MigrationChannelMessage)
    channel.close()
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

export const MigrationBridge = createSyncBridge({
  createWorker: () => new Worker(new URL('./migrate.worker.ts', import.meta.url), { type: 'module' }),
  sink,
  telemetry: sentryTelemetry,
  getAccountId: () => account,
  lockVault: lockVaultKeys,
})
