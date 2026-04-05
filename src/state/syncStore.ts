import { create } from 'zustand'

export interface SyncState {
  dlqCount: number
  isSyncing: boolean
  offlineQueueLength: number
}

export interface SyncStore extends SyncState {
  setDlqCount: (count: number) => void
  setIsSyncing: (status: boolean) => void
  setOfflineQueueLength: (length: number) => void
}

const initialSyncState: SyncState = {
  dlqCount: 0,
  isSyncing: false,
  offlineQueueLength: 0,
}

export const useSyncStore = create<SyncStore>(set => ({
  ...initialSyncState,
  setDlqCount: count => {
    set(() => ({ dlqCount: Math.max(0, count) }))
  },
  setIsSyncing: status => {
    set(() => ({ isSyncing: status }))
  },
  setOfflineQueueLength: length => {
    set(() => ({ offlineQueueLength: Math.max(0, length) }))
  },
}))
