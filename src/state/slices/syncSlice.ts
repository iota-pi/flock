import type { StateCreator } from 'zustand'
import type { AppStore } from '../store'
import type { SyncProgress, SyncStatus } from '@vault/client'


interface SyncState {
  syncStatus: SyncStatus
  /** How many items are waiting to sync and when this device last synced, once the worker has said */
  syncProgress: SyncProgress | null
  fatalError: string | null
  syncWarning: string | null
  generation: number
  isQuotaExceeded: boolean
  /** Set when this device's local data can't be opened (see LocalDataUnavailableDialog) */
  localDataUnavailable: { unpushedChanges: number } | null
  /** Set when another tab took the account over, so sync has stopped in this one (see DisplacedDialog) */
  displaced: boolean
  /** Whether the browser agreed to keep this site's storage from eviction; null until it has said */
  isStoragePersisted: boolean | null
}

export interface SyncSlice extends SyncState {
  setSyncStatus: (status: SyncState['syncStatus']) => void
  setSyncProgress: (progress: SyncProgress | null) => void
  setFatalError: (message: string) => void
  clearFatalError: () => void
  setSyncWarning: (message: string) => void
  clearSyncWarning: () => void
  incrementGeneration: () => void
  setQuotaExceeded: (exceeded: boolean) => void
  clearQuotaExceeded: () => void
  setLocalDataUnavailable: (details: SyncState['localDataUnavailable']) => void
  setDisplaced: (displaced: boolean) => void
  setStoragePersisted: (persisted: boolean) => void
}

const initialSyncState: SyncState = {
  syncStatus: 'idle',
  syncProgress: null,
  fatalError: null,
  syncWarning: null,
  generation: 0,
  isQuotaExceeded: false,
  localDataUnavailable: null,
  displaced: false,
  isStoragePersisted: null,
}

export const createSyncSlice: StateCreator<
  AppStore,
  [],
  [],
  SyncSlice
> = set => ({
  ...initialSyncState,
  setSyncStatus: status => {
    set(() => ({ syncStatus: status }))
  },
  setSyncProgress: progress => {
    set(() => ({ syncProgress: progress }))
  },
  setFatalError: message => {
    set(() => ({ fatalError: message }))
  },
  clearFatalError: () => {
    set(() => ({ fatalError: null }))
  },
  setSyncWarning: message => {
    set(() => ({ syncWarning: message }))
  },
  clearSyncWarning: () => {
    set(() => ({ syncWarning: null }))
  },
  incrementGeneration: () => {
    set(state => ({ generation: state.generation + 1 }))
  },
  setQuotaExceeded: exceeded => {
    set(() => ({
      isQuotaExceeded: exceeded,
    }))
  },
  clearQuotaExceeded: () => {
    set(() => ({
      isQuotaExceeded: false,
    }))
  },
  setLocalDataUnavailable: details => {
    set(() => ({ localDataUnavailable: details }))
  },
  setDisplaced: displaced => {
    set(() => ({ displaced }))
  },
  setStoragePersisted: persisted => {
    set(() => ({ isStoragePersisted: persisted }))
  },
})
