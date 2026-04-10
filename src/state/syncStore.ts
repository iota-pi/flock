import { create } from 'zustand'

export interface SyncState {
  isSyncing: boolean
  fatalError: string | null
}

export interface SyncStore extends SyncState {
  setIsSyncing: (status: boolean) => void
  setFatalError: (message: string) => void
  clearFatalError: () => void
}

const initialSyncState: SyncState = {
  isSyncing: false,
  fatalError: null,
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
}))
