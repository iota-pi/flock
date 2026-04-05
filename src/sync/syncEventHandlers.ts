import * as Sentry from '@sentry/react'
import { getQueryKey } from '@trpc/react-query'
import { queryClient } from '../api/queryClient'
import { trpc } from '../api/trpc'
import type { Item } from '../state/items'
import { useSyncStore } from '../state/syncStore'
import { useToastStore } from '../state/toastStore'
import { emitAppEvent } from '../app/appEvents'
import { subscribeSyncEvents, type SyncEvent } from './syncEvents'

const itemsQueryKey = getQueryKey(trpc.items.fetchMany)

function applyBaseStateRollback(targetId: string, baseState: Item): void {
  queryClient.setQueryData<Item[]>(itemsQueryKey, previous => {
    if (!previous) {
      return [baseState]
    }

    const index = previous.findIndex(item => item.id === targetId)
    if (index === -1) {
      return [...previous, baseState]
    }

    const next = [...previous]
    next[index] = baseState
    return next
  })
}

function handleSyncEvent(event: SyncEvent): void {
  const syncState = useSyncStore.getState()
  const toastState = useToastStore.getState()

  if (event.type === 'queue:length-changed') {
    syncState.setOfflineQueueLength(event.length)
    return
  }

  if (event.type === 'queue:dlq-count-changed') {
    syncState.setDlqCount(event.count)
    return
  }

  if (event.type === 'queue:processing-changed') {
    syncState.setIsSyncing(event.isSyncing)
    return
  }

  if (event.type === 'queue:mutation-success') {
    if (event.mutation.mutationType === 'items.put' || event.mutation.mutationType === 'items.putMany') {
      emitAppEvent({ type: 'data:updated', domain: 'items', reason: 'queue:mutation-success' })
    }
    if (event.mutation.mutationType === 'accounts.updateMetadata') {
      emitAppEvent({ type: 'data:updated', domain: 'metadata', reason: 'queue:mutation-success' })
    }
    return
  }

  if (event.type === 'queue:mutation-failed') {
    if (event.routedToDlq) {
      toastState.setMessage({
        severity: 'warning',
        message: 'An offline change was moved to recovery queue. Review Settings > Offline data recovery.',
      })
    }

    Sentry.captureMessage('Offline queue mutation failed', {
      level: event.routedToDlq ? 'warning' : 'error',
      extra: {
        mutationType: event.mutation.mutationType,
        mutationId: event.mutation.id,
        status: event.status,
        reason: event.reason,
        routedToDlq: event.routedToDlq,
      },
    })
    return
  }

  if (event.type === 'queue:rollback-base-state') {
    applyBaseStateRollback(event.targetId, event.baseState)
    emitAppEvent({ type: 'data:updated', domain: 'items', reason: 'queue:rollback-base-state' })
    return
  }

  if (event.type === 'queue:health-warning') {
    Sentry.captureMessage(
      event.code === 'high-volume' ? 'High Offline Queue Volume' : 'Stale Offline Queue Detected',
      {
        level: event.code === 'high-volume' ? 'warning' : 'error',
        extra: {
          queueLength: event.queueLength,
          oldestItemAgeMinutes: event.oldestItemAgeMinutes,
        },
      },
    )
    return
  }

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
    emitAppEvent({ type: 'data:updated', domain: 'items', reason: 'sync:item-recovered' })
  }
}

export function startSyncEventHandlers(): () => void {
  return subscribeSyncEvents(handleSyncEvent)
}
