export type SyncRuntimeState = {
  isSyncing: boolean
  offlineQueueLength: number
  dlqCount: number
}

export type SyncRuntimeMessage = {
  severity: 'success' | 'info' | 'warning' | 'error'
  message: string
}

type SyncStateListener = (state: SyncRuntimeState) => void
type SyncMessageListener = (event: SyncRuntimeMessage) => void

const listeners = new Set<SyncStateListener>()
const messageListeners = new Set<SyncMessageListener>()

let state: SyncRuntimeState = {
  isSyncing: false,
  offlineQueueLength: 0,
  dlqCount: 0,
}

export function getSyncRuntimeState(): SyncRuntimeState {
  return state
}

export function setSyncRuntimeState(next: Partial<SyncRuntimeState>) {
  state = {
    ...state,
    ...next,
  }

  for (const listener of listeners) {
    listener(state)
  }
}

export function emitSyncRuntimeMessage(event: SyncRuntimeMessage) {
  for (const listener of messageListeners) {
    listener(event)
  }
}

export function subscribeSyncRuntime(listener: SyncStateListener): () => void {
  listeners.add(listener)
  listener(state)

  return () => {
    listeners.delete(listener)
  }
}

export function subscribeSyncRuntimeMessages(listener: SyncMessageListener): () => void {
  messageListeners.add(listener)

  return () => {
    messageListeners.delete(listener)
  }
}
