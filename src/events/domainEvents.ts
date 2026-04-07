export type DomainEvent =
  | {
    type: 'sync:processing-changed'
    isSyncing: boolean
  }
  | {
    type: 'sync:recovery-count-changed'
    count: number
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
