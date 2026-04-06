import { emitDomainEvent, subscribeDomainEvents, type DomainEvent } from '../events/domainEvents'

export type AppEvent = Extract<DomainEvent, { type: 'data:updated' }>

type AppEventListener = (event: AppEvent) => void

export function emitAppEvent(event: AppEvent): void {
  emitDomainEvent(event)
}

export function subscribeAppEvents(listener: AppEventListener): () => void {
  return subscribeDomainEvents(event => {
    if (event.type === 'data:updated') {
      listener(event)
    }
  })
}
