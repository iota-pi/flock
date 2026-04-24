import { create } from 'zustand'

interface SyncState {
  status: 'idle' | 'connecting' | 'syncing' | 'offline' | 'degraded'
  fatalError: string | null
  syncWarning: string | null
}

interface SyncStore extends SyncState {
  setSyncStatus: (status: SyncState['status']) => void
  setFatalError: (message: string) => void
  clearFatalError: () => void
  setSyncWarning: (message: string) => void
  clearSyncWarning: () => void
}

const initialSyncState: SyncState = {
  status: 'idle',
  fatalError: null,
  syncWarning: null,
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
}))
