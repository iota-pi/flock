import { emitDomainEvent, subscribeDomainEvents, type DomainEvent } from '../events/domainEvents'

export type SyncEvent = Extract<DomainEvent,
  | { type: 'queue:length-changed' }
  | { type: 'queue:dlq-count-changed' }
  | { type: 'queue:processing-changed' }
  | { type: 'queue:mutation-success' }
  | { type: 'queue:mutation-failed' }
  | { type: 'queue:rollback-base-state' }
  | { type: 'queue:health-warning' }
  | { type: 'sync:item-corrupted' }
  | { type: 'sync:item-recovered' }
>

type SyncEventListener = (event: SyncEvent) => void

function isSyncEvent(event: DomainEvent): event is SyncEvent {
  return event.type.startsWith('queue:') || event.type.startsWith('sync:')
}

export function emitSyncEvent(event: SyncEvent): void {
  emitDomainEvent(event)
}

export function subscribeSyncEvents(listener: SyncEventListener): () => void {
  return subscribeDomainEvents(event => {
    if (isSyncEvent(event)) {
      listener(event)
    }
  })
}