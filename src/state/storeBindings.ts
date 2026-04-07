import { subscribeDomainEvents, type DomainEvent } from '../events/domainEvents'
import { useNavigationStore } from './navigationStore'
import { useSyncStore } from './syncStore'

let stopBindings: (() => void) | null = null

function handleDomainEvent(event: DomainEvent): void {
  const syncStore = useSyncStore.getState()

  if (event.type === 'sync:recovery-count-changed') {
    syncStore.setRecoveryCount(event.count)
    return
  }

  if (event.type === 'sync:processing-changed') {
    syncStore.setIsSyncing(event.isSyncing)
    return
  }

  if (event.type === 'data:deleted' && event.domain === 'items') {
    useNavigationStore.getState().pruneItemDrawers(event.ids)
  }
}

export function startStoreBindings(): () => void {
  if (stopBindings) {
    return stopBindings
  }

  const unsubscribe = subscribeDomainEvents(handleDomainEvent)
  stopBindings = () => {
    unsubscribe()
    stopBindings = null
  }

  return stopBindings
}
