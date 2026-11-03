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
  isLeaderConflict: boolean
  /** Set when this device's local data can't be opened (see LocalDataUnavailableDialog) */
  localDataUnavailable: { unpushedChanges: number } | null
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
  setLeaderConflict: (isConflict: boolean) => void
  setLocalDataUnavailable: (details: SyncState['localDataUnavailable']) => void
}

const initialSyncState: SyncState = {
  syncStatus: 'idle',
  syncProgress: null,
  fatalError: null,
  syncWarning: null,
  generation: 0,
  isQuotaExceeded: false,
  isLeaderConflict: false,
  localDataUnavailable: null,
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
  setLeaderConflict: isConflict => {
    set(() => ({
      isLeaderConflict: isConflict,
    }))
  },
  setLocalDataUnavailable: details => {
    set(() => ({ localDataUnavailable: details }))
  },
})
