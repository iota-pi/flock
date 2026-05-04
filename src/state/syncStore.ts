import { create } from 'zustand'

export type SyncStatus = 'idle' | 'connecting' | 'syncing' | 'offline' | 'degraded'

interface SyncState {
  status: SyncStatus
  fatalError: string | null
  syncWarning: string | null
  generation: number
}

interface SyncStore extends SyncState {
  setSyncStatus: (status: SyncState['status']) => void
  setFatalError: (message: string) => void
  clearFatalError: () => void
  setSyncWarning: (message: string) => void
  clearSyncWarning: () => void
  incrementGeneration: () => void
}

const initialSyncState: SyncState = {
  status: 'idle',
  fatalError: null,
  syncWarning: null,
  generation: 0,
}

export const useSyncStore = create<SyncStore>(set => ({
  ...initialSyncState,
  setSyncStatus: status => {
    set(() => ({ status }))
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
}))
