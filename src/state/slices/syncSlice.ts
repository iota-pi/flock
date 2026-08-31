import type { StateCreator } from 'zustand'
import type { AppStore } from '../store'

export type SyncStatus = 'idle' | 'connecting' | 'syncing' | 'offline' | 'degraded' | 'dead'

interface SyncState {
  syncStatus: SyncStatus
  fatalError: string | null
  syncWarning: string | null
  generation: number
}

export interface SyncSlice extends SyncState {
  setSyncStatus: (status: SyncState['syncStatus']) => void
  setFatalError: (message: string) => void
  clearFatalError: () => void
  setSyncWarning: (message: string) => void
  clearSyncWarning: () => void
  incrementGeneration: () => void
}

const initialSyncState: SyncState = {
  syncStatus: 'idle',
  fatalError: null,
  syncWarning: null,
  generation: 0,
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
})
