import { create } from 'zustand'

interface SyncState {
  isSyncing: boolean
  fatalError: string | null
  syncWarning: string | null
}

interface SyncStore extends SyncState {
  setIsSyncing: (status: boolean) => void
  setFatalError: (message: string) => void
  clearFatalError: () => void
  setSyncWarning: (message: string) => void
  clearSyncWarning: () => void
}

const initialSyncState: SyncState = {
  isSyncing: false,
  fatalError: null,
  syncWarning: null,
}

export const useSyncStore = create<SyncStore>(set => ({
  ...initialSyncState,
  setIsSyncing: status => {
    set(() => ({ isSyncing: status }))
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
