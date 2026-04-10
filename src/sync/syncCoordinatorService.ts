import {
  setRealtimeCoordinatorTransportPaused,
  startRealtimeCoordinator,
  stopRealtimeCoordinator,
} from '../api/realtimeCoordinator'
import { getApiAuthToken, subscribeApiAuthToken } from '../api/runtime'
import { initializeSyncHealthWatchers } from '../api/syncHealthCoordinator'
import { pullRemoteMessagesNow, requestAutomergeSync } from './automergeSyncDispatcher'

type SyncCoordinatorOptions = {
  account: string
}

export class SyncCoordinatorService {
  private activeKey = ''
  private activeCleanup: (() => void) | null = null

  constructor(private readonly hiddenDisconnectDelayMs = 30 * 1000) {}

  start(options: SyncCoordinatorOptions): void {
    const key = options.account
    if (this.activeCleanup && this.activeKey === key) {
      return
    }

    this.stop()
    this.activeKey = key

    initializeSyncHealthWatchers()

    const handleOnline = () => {
      requestAutomergeSync()
    }

    const handleServiceWorkerMessage = (event: MessageEvent) => {
      const payload = event.data as {
        type?: string
        account?: string
        itemIds?: unknown
      }

      if (payload?.type !== 'FLOCK_BACKGROUND_SYNC_PUSHED' || payload.account !== options.account) {
        return
      }

      const itemIds = Array.isArray(payload.itemIds)
        ? payload.itemIds.filter((itemId): itemId is string => typeof itemId === 'string' && itemId.length > 0)
        : undefined

      void pullRemoteMessagesNow(itemIds).catch(() => undefined)
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('online', handleOnline)
    }

    if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
      navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage)
    }

    let realtimeStarted = false
    let isTransportPaused = false
    const isDocumentHidden = (): boolean => {
      return typeof document !== 'undefined' && document.visibilityState === 'hidden'
    }

    const pauseRealtimeTransport = (): void => {
      if (!realtimeStarted || isTransportPaused) {
        return
      }

      setRealtimeCoordinatorTransportPaused(true)
      isTransportPaused = true
    }

    const resumeRealtimeTransport = (): void => {
      if (!realtimeStarted || !isTransportPaused) {
        return
      }

      setRealtimeCoordinatorTransportPaused(false)
      isTransportPaused = false
    }

    const startRealtimeIfAuthorized = (): void => {
      if (realtimeStarted) {
        if (isDocumentHidden()) {
          pauseRealtimeTransport()
        } else {
          resumeRealtimeTransport()
        }
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
            requestAutomergeSync()
          }
        },
      })

      realtimeStarted = true
      isTransportPaused = false

      if (isDocumentHidden()) {
        pauseRealtimeTransport()
      }
    }

    const stopRealtime = (): void => {
      if (!realtimeStarted) {
        return
      }

      stopRealtimeCoordinator()
      realtimeStarted = false
      isTransportPaused = false
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
            pauseRealtimeTransport()
          }
        }, this.hiddenDisconnectDelayMs)
        return
      }

      clearHiddenDisconnectTimer()
      startRealtimeIfAuthorized()
      if (isTransportPaused) {
        resumeRealtimeTransport()
      }
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange)
    }

    startRealtimeIfAuthorized()
    const unsubscribeAuthToken = subscribeApiAuthToken(token => {
      if (token) {
        startRealtimeIfAuthorized()
        requestAutomergeSync()
      } else {
        stopRealtime()
      }
    })

    requestAutomergeSync()

    this.activeCleanup = () => {
      unsubscribeAuthToken()
      clearHiddenDisconnectTimer()
      stopRealtime()

      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange)
      }

      if (typeof window !== 'undefined') {
        window.removeEventListener('online', handleOnline)
      }

      if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
        navigator.serviceWorker.removeEventListener('message', handleServiceWorkerMessage)
      }
    }
  }

  stop(): void {
    if (!this.activeCleanup) {
      return
    }

    this.activeCleanup()
    this.activeCleanup = null
    this.activeKey = ''
  }
}

export type { SyncCoordinatorOptions }