import { emitAppEvent } from '../app/appEvents'
import { startDataInvalidationController } from '../api/dataInvalidationController'
import { startRealtimeCoordinator, stopRealtimeCoordinator } from '../api/realtimeCoordinator'
import { getApiAuthToken, subscribeApiAuthToken } from '../api/runtime'
import { ensureItemsBootstrap } from '../api/itemReadService'
import { initializeSyncHealthWatchers } from '../api/syncHealthCoordinator'
import {
  requestAutomergeSync,
  startAutomergeSyncDispatcher,
  stopAutomergeSyncDispatcher,
} from './automergeSyncDispatcher'
import { initializeAutomergeDocStore } from './automergeDocStore'
import { readManualRecoveryCount } from './manualRecoveryStore'
import { useSyncStore } from '../state/syncStore'

type SyncCoordinatorOptions = {
  account: string
}

let activeKey = ''
let activeCleanup: (() => void) | null = null
const HIDDEN_DISCONNECT_DELAY_MS = 30 * 1000

export function startSyncCoordinator(options: SyncCoordinatorOptions): void {
  const key = options.account
  if (activeCleanup && activeKey === key) {
    return
  }

  stopSyncCoordinator()
  activeKey = key

  const unsubscribeDataInvalidation = startDataInvalidationController()

  initializeSyncHealthWatchers()

  void initializeAutomergeDocStore(options.account)
  startAutomergeSyncDispatcher(options.account)
  void readManualRecoveryCount().then(count => {
    useSyncStore.getState().setRecoveryCount(count)
  })

  const handleOnline = () => {
    requestAutomergeSync()
  }

  const bootstrapItemsIfAuthorized = () => {
    if (!getApiAuthToken()) {
      return
    }

    void ensureItemsBootstrap(options.account).catch(() => undefined)
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('online', handleOnline)
  }

  let realtimeStarted = false
  function startRealtimeIfAuthorized(): void {
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
      onSyncPing: itemIds => {
        requestAutomergeSync(itemIds)
      },
    })

    realtimeStarted = true
    emitAppEvent({ type: 'data:updated', domain: 'items', reason: 'realtime:start' })
  }

  function stopRealtime(): void {
    if (!realtimeStarted) {
      return
    }

    stopRealtimeCoordinator()
    realtimeStarted = false
  }

  let hiddenDisconnectTimer: ReturnType<typeof setTimeout> | null = null

  const clearHiddenDisconnectTimer = () => {
    if (!hiddenDisconnectTimer) {
      return
    }

    clearTimeout(hiddenDisconnectTimer)
    hiddenDisconnectTimer = null
  }

  const handleVisibilityChange = () => {
    if (typeof document === 'undefined') {
      return
    }

    if (document.visibilityState === 'hidden') {
      clearHiddenDisconnectTimer()
      hiddenDisconnectTimer = setTimeout(() => {
        hiddenDisconnectTimer = null
        if (document.visibilityState === 'hidden') {
          stopRealtime()
        }
      }, HIDDEN_DISCONNECT_DELAY_MS)
      return
    }

    clearHiddenDisconnectTimer()
    startRealtimeIfAuthorized()
    requestAutomergeSync()
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChange)
  }

  startRealtimeIfAuthorized()
  bootstrapItemsIfAuthorized()
  const unsubscribeAuthToken = subscribeApiAuthToken(token => {
    if (token) {
      startRealtimeIfAuthorized()
      bootstrapItemsIfAuthorized()
      requestAutomergeSync()
    } else {
      stopRealtime()
    }
  })

  requestAutomergeSync()

  activeCleanup = () => {
    unsubscribeDataInvalidation()
    unsubscribeAuthToken()
    clearHiddenDisconnectTimer()
    stopRealtime()
    stopAutomergeSyncDispatcher()

    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }

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