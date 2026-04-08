import { create } from 'zustand'

export interface SyncState {
  isSyncing: boolean
}

export interface SyncStore extends SyncState {
  setIsSyncing: (status: boolean) => void
}

const initialSyncState: SyncState = {
  isSyncing: false,
}

export const useSyncStore = create<SyncStore>(set => ({
  ...initialSyncState,
  setIsSyncing: status => {
    set(() => ({ isSyncing: status }))
  },
}))
