import { create } from 'zustand'

export interface SyncState {
  isSyncing: boolean
  fatalError: string | null
  syncWarning: string | null
  activeAccount: string | null
}

export interface SyncStore extends SyncState {
  setIsSyncing: (status: boolean) => void
  setActiveAccount: (account: string | null) => void
  setFatalError: (message: string) => void
  clearFatalError: () => void
  setSyncWarning: (message: string) => void
  clearSyncWarning: () => void
}

const initialSyncState: SyncState = {
  isSyncing: false,
  fatalError: null,
  syncWarning: null,
  activeAccount: null,
}

export const useSyncStore = create<SyncStore>(set => ({
  ...initialSyncState,
  setIsSyncing: status => {
    set(() => ({ isSyncing: status }))
  },
  setActiveAccount: account => {
    set(() => ({ activeAccount: account }))
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
