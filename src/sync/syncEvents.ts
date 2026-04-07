import { emitDomainEvent, subscribeDomainEvents, type DomainEvent } from '../events/domainEvents'

export type SyncEvent = Extract<DomainEvent,
  | { type: 'sync:processing-changed' }
  | { type: 'sync:recovery-count-changed' }
  | { type: 'sync:item-corrupted' }
  | { type: 'sync:item-recovered' }
>

type SyncEventListener = (event: SyncEvent) => void

function isSyncEvent(event: DomainEvent): event is SyncEvent {
  return event.type.startsWith('sync:')
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