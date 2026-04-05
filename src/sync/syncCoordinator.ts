import * as Sentry from '@sentry/react'
import { getQueryKey } from '@trpc/react-query'
import { queryClient } from '../api/queryClient'
import { processRealtimeItemEvents } from '../api/itemReadService'
import { startRealtimeCoordinator, stopRealtimeCoordinator } from '../api/realtimeCoordinator'
import { getApiAuthToken } from '../api/runtime'
import { initializeSyncHealthWatchers } from '../api/syncHealthCoordinator'
import { trpc } from '../api/trpc'
import type { Item } from '../state/items'
import { useUiStore } from '../state/uiStore'
import {
  initialiseDeadLetterQueueCount,
  processOfflineQueue,
  startOfflineQueueHealthMonitor,
} from './offlineQueue'
import { startQueueLeaderLock, stopQueueLeaderLock, requestQueueProcessing } from './queueLeaderLock'
import { subscribeSyncEvents, type SyncEvent } from './syncEvents'

type SyncCoordinatorOptions = {
  account: string
}

const itemsQueryKey = getQueryKey(trpc.items.fetchMany)
const metadataQueryKey = getQueryKey(trpc.accounts.getMetadata)

let activeKey = ''
let activeCleanup: (() => void) | null = null

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
  const ui = useUiStore.getState()

  if (event.type === 'queue:length-changed') {
    ui.setOfflineQueueLength(event.length)
    return
  }

  if (event.type === 'queue:dlq-count-changed') {
    ui.setDlqCount(event.count)
    return
  }

  if (event.type === 'queue:processing-changed') {
    ui.setIsSyncing(event.isSyncing)
    return
  }

  if (event.type === 'queue:mutation-success') {
    if (event.mutation.mutationType === 'items.put' || event.mutation.mutationType === 'items.putMany') {
      void queryClient.invalidateQueries({ queryKey: itemsQueryKey })
    }
    if (event.mutation.mutationType === 'accounts.updateMetadata') {
      void queryClient.invalidateQueries({ queryKey: metadataQueryKey })
    }
    return
  }

  if (event.type === 'queue:mutation-failed') {
    if (event.routedToDlq) {
      ui.setMessage({
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
    ui.setMessage({
      severity: 'warning',
      message: 'A corrupted item was detected. Recovery will be attempted automatically.',
    })
    return
  }

  if (event.type === 'sync:item-recovered') {
    ui.setMessage({
      severity: 'success',
      message: 'Recovered a corrupted item revision.',
    })
  }
}

export function startSyncCoordinator(options: SyncCoordinatorOptions): void {
  const key = options.account
  if (activeCleanup && activeKey === key) {
    return
  }

  stopSyncCoordinator()
  activeKey = key

  const unsubscribeSyncEvents = subscribeSyncEvents(handleSyncEvent)

  initializeSyncHealthWatchers()
  startOfflineQueueHealthMonitor()

  startQueueLeaderLock({
    account: options.account,
    onProcessRequested: () => {
      void processOfflineQueue()
    },
  })

  const handleOnline = () => {
    requestQueueProcessing()
    void processOfflineQueue()
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('online', handleOnline)
  }

  let realtimeStarted = false
  const tryStartRealtime = () => {
    if (realtimeStarted) {
      return
    }

    const token = getApiAuthToken()
    if (!token) {
      return
    }

    startRealtimeCoordinator({
      account: options.account,
      onServerEvent: event => {
        if (event.eventType === 'metadata.updated') {
          void queryClient.invalidateQueries({ queryKey: metadataQueryKey })
        }
      },
      onItemEvents: events => {
        void (async () => {
          await processRealtimeItemEvents(events)
          requestQueueProcessing()
          await processOfflineQueue()
        })()
      },
    })

    realtimeStarted = true
    void queryClient.invalidateQueries({ queryKey: itemsQueryKey })
  }

  tryStartRealtime()
  const realtimeStartInterval = typeof window === 'undefined'
    ? null
    : window.setInterval(tryStartRealtime, 500)

  void (async () => {
    await initialiseDeadLetterQueueCount()
    requestQueueProcessing()
    await processOfflineQueue()
  })()

  activeCleanup = () => {
    unsubscribeSyncEvents()
    stopRealtimeCoordinator()
    stopQueueLeaderLock()

    if (typeof window !== 'undefined') {
      window.removeEventListener('online', handleOnline)
    }

    if (typeof realtimeStartInterval === 'number') {
      window.clearInterval(realtimeStartInterval)
    }
  }
}

export function stopSyncCoordinator(): void {
  if (!activeCleanup) {
    return
  }

  activeCleanup()
  activeCleanup = null
  activeKey = ''
}