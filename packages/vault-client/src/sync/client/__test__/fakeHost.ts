import type { SyncStatus } from '../../shared/types'
import type { SyncStateSink, SyncTelemetry } from '../host'

export interface FakeSyncState {
  syncStatus: SyncStatus
  syncWarning: string | null
  fatalError: string | null
  isQuotaExceeded: boolean
  isLeaderConflict: boolean
}

/** An in-memory SyncStateSink that records state the way an app store would */
export function createFakeSink() {
  const state: FakeSyncState = {
    syncStatus: 'idle',
    syncWarning: null,
    fatalError: null,
    isQuotaExceeded: false,
    isLeaderConflict: false,
  }
  const sink = {
    state,
    updateItems: vi.fn(),
    updateIndex: vi.fn(),
    updateMetadata: vi.fn(),
    getSyncStatus: () => state.syncStatus,
    setSyncStatus: vi.fn((status: SyncStatus) => {
      state.syncStatus = status
    }),
    getSyncWarning: () => state.syncWarning,
    setSyncWarning: vi.fn((message: string) => {
      state.syncWarning = message
    }),
    clearSyncWarning: vi.fn(() => {
      state.syncWarning = null
    }),
    setFatalError: vi.fn((message: string) => {
      state.fatalError = message
    }),
    setQuotaExceeded: vi.fn((exceeded: boolean) => {
      state.isQuotaExceeded = exceeded
    }),
    setLeaderConflict: vi.fn((hasConflict: boolean) => {
      state.isLeaderConflict = hasConflict
    }),
    startRequest: vi.fn(),
    finishRequest: vi.fn(),
    reset: vi.fn(),
    onDataRestored: vi.fn(),
    onLocalDataUnavailable: vi.fn(),
    beforeRetiringLegacyStores: vi.fn(),
  } satisfies SyncStateSink & { state: FakeSyncState }
  return sink
}

export function createFakeTelemetry() {
  return {
    setUser: vi.fn(),
    setTag: vi.fn(),
    addBreadcrumb: vi.fn(),
    captureException: vi.fn(),
  } satisfies SyncTelemetry
}
