export {
  enqueueMutation,
  initialiseDeadLetterQueueCount,
  processOfflineQueue,
  registerBackgroundSync,
  startOfflineQueueHealthMonitor,
  CONFLICT_HANDLER_AUTOMERGE_ITEMS,
  isLikelyNetworkError,
} from './offlineQueue'

export {
  OFFLINE_QUEUE_SYNC_TAG,
  OFFLINE_QUEUE_KEY,
  ACTIVE_SESSION_TOKEN_KEY,
  DEAD_LETTER_QUEUE_KEY,
  getMutationId,
  readQueue,
  writeQueue,
  readDeadLetterQueue,
  writeDeadLetterQueue,
  moveToDeadLetterQueue,
  getActiveSessionToken,
  setActiveSessionToken,
  clearActiveSessionToken,
  clearOfflineQueue,
} from './offlineQueueStore'

export type {
  DlqFailureSnapshot,
  QueuedMutation,
} from './offlineQueueStore'
