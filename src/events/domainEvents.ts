export type DomainEvent =
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
