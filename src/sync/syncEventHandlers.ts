import * as Sentry from '@sentry/react'
import { getQueryKey } from '@trpc/react-query'
import { queryClient } from '../api/queryClient'
import { trpc } from '../api/trpc'
import { useToastStore } from '../state/toastStore'
import { subscribeSyncEvents, type SyncEvent } from './syncEvents'

const itemsQueryKey = getQueryKey(trpc.items.fetchMany)

function handleSyncEvent(event: SyncEvent): void {
  const toastState = useToastStore.getState()

  if (event.type === 'sync:item-corrupted') {
    toastState.setMessage({
      severity: 'warning',
      message: 'A corrupted item was detected. Recovery will be attempted automatically.',
    })
    return
  }

  if (event.type === 'sync:item-recovered') {
    toastState.setMessage({
      severity: 'success',
      message: 'Recovered a corrupted item revision.',
    })
    void queryClient.invalidateQueries({ queryKey: itemsQueryKey })
    return
  }

  if (event.type === 'sync:recovery-count-changed' && event.count > 0) {
    Sentry.captureMessage('Manual recovery required for corrupted items', {
      level: 'warning',
      extra: {
        count: event.count,
      },
    })
  }
}

export function startSyncEventHandlers(): () => void {
  return subscribeSyncEvents(handleSyncEvent)
}
