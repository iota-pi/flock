import type { Item } from '../state/items'
import type { QueuedMutation } from './offlineQueueStore'

export type SyncEvent =
  | {
    type: 'queue:length-changed'
    length: number
  }
  | {
    type: 'queue:dlq-count-changed'
    count: number
  }
  | {
    type: 'queue:processing-changed'
    isSyncing: boolean
  }
  | {
    type: 'queue:mutation-success'
    mutation: QueuedMutation
  }
  | {
    type: 'queue:mutation-failed'
    mutation: QueuedMutation
    status?: number
    reason: string
    routedToDlq: boolean
  }
  | {
    type: 'queue:rollback-base-state'
    mutation: QueuedMutation
    targetId: string
    baseState: Item
  }
  | {
    type: 'queue:health-warning'
    code: 'high-volume' | 'stale'
    queueLength: number
    oldestItemAgeMinutes: number
  }
  | {
    type: 'sync:item-corrupted'
    itemId?: string
    reason: string
  }
  | {
    type: 'sync:item-recovered'
    itemId: string
  }

type SyncEventListener = (event: SyncEvent) => void

const listeners = new Set<SyncEventListener>()

export function emitSyncEvent(event: SyncEvent): void {
  for (const listener of listeners) {
    listener(event)
  }
}

export function subscribeSyncEvents(listener: SyncEventListener): () => void {
  listeners.add(listener)

  return () => {
    listeners.delete(listener)
  }
}