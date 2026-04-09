import { startRealtimeCoordinator, stopRealtimeCoordinator } from '../api/realtimeCoordinator'
import { getApiAuthToken, subscribeApiAuthToken } from '../api/runtime'
import { initializeSyncHealthWatchers } from '../api/syncHealthCoordinator'
import { requestAutomergeSync } from './automergeSyncDispatcher'
import { initializeAutomergeDocStore } from './automergeDocStore'

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

    void initializeAutomergeDocStore(options.account)

    const handleOnline = () => {
      requestAutomergeSync()
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('online', handleOnline)
    }

    let realtimeStarted = false
    const startRealtimeIfAuthorized = (): void => {
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
            requestAutomergeSync()
          }
        },
      })

      realtimeStarted = true
    }

    const stopRealtime = (): void => {
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
        }, this.hiddenDisconnectDelayMs)
        return
      }

      clearHiddenDisconnectTimer()
      startRealtimeIfAuthorized()
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