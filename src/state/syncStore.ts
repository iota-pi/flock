import { create } from 'zustand'

export interface SyncState {
  recoveryCount: number
  isSyncing: boolean
}

export interface SyncStore extends SyncState {
  setRecoveryCount: (count: number) => void
  setIsSyncing: (status: boolean) => void
}

const initialSyncState: SyncState = {
  recoveryCount: 0,
  isSyncing: false,
}

export const useSyncStore = create<SyncStore>(set => ({
  ...initialSyncState,
  setRecoveryCount: count => {
    set(() => ({ recoveryCount: Math.max(0, count) }))
  },
  setIsSyncing: status => {
    set(() => ({ isSyncing: status }))
  },
}))
