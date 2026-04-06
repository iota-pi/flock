import type { Item } from '../state/items'
import type { QueuedMutation } from '../sync/offlineQueueStore'

export type DomainEvent =
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
  | {
    type: 'data:updated'
    domain: string
    reason?: string
  }
  | {
    type: 'data:deleted'
    domain: 'items'
    ids: string[]
  }

type DomainEventListener = (event: DomainEvent) => void

const listeners = new Set<DomainEventListener>()

export function emitDomainEvent(event: DomainEvent): void {
  for (const listener of listeners) {
    listener(event)
  }
}

export function subscribeDomainEvents(listener: DomainEventListener): () => void {
  listeners.add(listener)

  return () => {
    listeners.delete(listener)
  }
}
