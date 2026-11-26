import * as Sentry from '@sentry/react'
import { createSyncBridge, lockVaultKeys } from '@vault/client'
import type { SyncStateSink, SyncStatus, SyncTelemetry } from '@vault/client'
import { MIGRATION_CHANNEL, type MigrationChannelMessage } from './detection'

export interface MigrationSyncState {
  status: SyncStatus
  warning: string | null
  fatalError: string | null
  /** Another tab took the account over, which stopped this page's sync until it takes it back */
  displaced: boolean
}

const initialState: MigrationSyncState = { status: 'connecting', warning: null, fatalError: null, displaced: false }

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
  setSyncStatus: status => setState({ status }),
  getSyncWarning: () => state.warning,
  setSyncWarning: warning => setState({ warning }),
  clearSyncWarning: () => setState({ warning: null }),
  setFatalError: fatalError => setState({ fatalError }),
  setQuotaExceeded: () => {},
  startRequest: () => {},
  finishRequest: () => {},
  reset: () => setState(initialState),
  onDisplaced: () => setState({ displaced: true }),
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

/** Takes the account back from a tab that took it over, if one did */
export async function takeAccountBack(): Promise<void> {
  if (!MigrationBridge.isDisplaced()) return
  setState({ displaced: false })
  await MigrationBridge.takeOverHere(account)
}
