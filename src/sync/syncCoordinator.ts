import { startRealtimeCoordinator, stopRealtimeCoordinator } from '../api/realtimeCoordinator'
import { getApiAuthToken, subscribeApiAuthToken } from '../api/runtime'
import { ensureItemsBootstrap, ensureMetadataLoaded } from '../api/itemReadService'
import { initializeSyncHealthWatchers } from '../api/syncHealthCoordinator'
import {
  requestAutomergeSync,
  startAutomergeSyncDispatcher,
  stopAutomergeSyncDispatcher,
} from './automergeSyncDispatcher'
import { ACCOUNT_METADATA_DOCUMENT_ID, initializeAutomergeDocStore } from './automergeDocStore'

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

  initializeSyncHealthWatchers()

  void initializeAutomergeDocStore(options.account)
  startAutomergeSyncDispatcher(options.account)

  const handleOnline = () => {
    requestAutomergeSync()
  }

  const bootstrapItemsIfAuthorized = () => {
    if (!getApiAuthToken()) {
      return
    }

    void ensureItemsBootstrap(options.account).catch(() => undefined)
    void ensureMetadataLoaded(options.account).catch(() => undefined)
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
          requestAutomergeSync([ACCOUNT_METADATA_DOCUMENT_ID])
          void ensureMetadataLoaded(options.account, { force: true })
        }
      },
      onSyncPing: itemIds => {
        requestAutomergeSync(itemIds)
      },
    })

    realtimeStarted = true
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
    void ensureMetadataLoaded(options.account).catch(() => undefined)
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
      void ensureMetadataLoaded(options.account).catch(() => undefined)
    } else {
      stopRealtime()
    }
  })

  requestAutomergeSync()

  activeCleanup = () => {
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