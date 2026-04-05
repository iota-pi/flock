import { emitAppEvent } from '../app/appEvents'
import { startDataInvalidationController } from '../api/dataInvalidationController'
import { processRealtimeItemEvents } from '../api/itemReadService'
import { startRealtimeCoordinator, stopRealtimeCoordinator } from '../api/realtimeCoordinator'
import { getApiAuthToken, subscribeApiAuthToken } from '../api/runtime'
import { initializeSyncHealthWatchers } from '../api/syncHealthCoordinator'
import {
  initialiseDeadLetterQueueCount,
  processOfflineQueue,
  startOfflineQueueHealthMonitor,
} from './offlineQueue'
import { startQueueLeaderLock, stopQueueLeaderLock, requestQueueProcessing } from './queueLeaderLock'
import { startSyncEventHandlers } from './syncEventHandlers'

type SyncCoordinatorOptions = {
  account: string
}

let activeKey = ''
let activeCleanup: (() => void) | null = null

export function startSyncCoordinator(options: SyncCoordinatorOptions): void {
  const key = options.account
  if (activeCleanup && activeKey === key) {
    return
  }

  stopSyncCoordinator()
  activeKey = key

  const unsubscribeSyncEvents = startSyncEventHandlers()
  const unsubscribeDataInvalidation = startDataInvalidationController()

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
  const startRealtimeIfAuthorized = () => {
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
          emitAppEvent({ type: 'data:updated', domain: 'metadata', reason: 'realtime:event' })
        }
      },
      onItemEvents: events => {
        void (async () => {
          await processRealtimeItemEvents(events)
          emitAppEvent({ type: 'data:updated', domain: 'items', reason: 'realtime:event' })
          requestQueueProcessing()
          await processOfflineQueue()
        })()
      },
    })

    realtimeStarted = true
    emitAppEvent({ type: 'data:updated', domain: 'items', reason: 'realtime:start' })
  }

  const stopRealtime = () => {
    if (!realtimeStarted) {
      return
    }

    stopRealtimeCoordinator()
    realtimeStarted = false
  }

  startRealtimeIfAuthorized()
  const unsubscribeAuthToken = subscribeApiAuthToken(token => {
    if (token) {
      startRealtimeIfAuthorized()
    } else {
      stopRealtime()
    }
  })

  void (async () => {
    await initialiseDeadLetterQueueCount()
    requestQueueProcessing()
    await processOfflineQueue()
  })()

  activeCleanup = () => {
    unsubscribeSyncEvents()
    unsubscribeDataInvalidation()
    unsubscribeAuthToken()
    stopRealtime()
    stopQueueLeaderLock()

    if (typeof window !== 'undefined') {
      window.removeEventListener('online', handleOnline)
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