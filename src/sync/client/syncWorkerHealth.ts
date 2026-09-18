import { useAppStore } from '../../state/store'

export const HEARTBEAT_INTERVAL_MS = 15000
export const HEARTBEAT_TIMEOUT_MS = 30000
export const MAX_CONSECUTIVE_CRASHES = 3
export const MAX_CONSECUTIVE_TIMEOUTS = 5
export const CRASH_RESET_WINDOW_MS = 60000
export const DEFAULT_MAX_MISSED_PINGS = 2

export interface SendPingOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export interface HealthCheckOptions {
  worker: Worker
  pingPort: MessagePort
  isCurrentWorker: () => boolean
  onCrash: (willRestart?: boolean) => void
  onRestart: () => void
  heartbeatIntervalMs?: number
  heartbeatTimeoutMs?: number
  maxMissedPings?: number
}

interface CrashDetails {
  worker: Worker
  onCrash: (willRestart?: boolean) => void
  onRestart: () => void
  isTimeout?: boolean
}

export const sendPing = (
  port: MessagePort,
  optionsOrSignal?: SendPingOptions | AbortSignal
): Promise<void> => {
  const signal = optionsOrSignal instanceof AbortSignal
    ? optionsOrSignal
    : optionsOrSignal?.signal
  const timeoutMs = optionsOrSignal instanceof AbortSignal
    ? undefined
    : optionsOrSignal?.timeoutMs

  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Ping aborted'))
      return
    }

    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const handleMessage = (event: MessageEvent) => {
      if (event.data === 'pong') {
        cleanup()
        recordWorkerActivity()
        resolve()
      }
    }

    const handleMessageError = () => {
      cleanup()
      reject(new Error('MessagePort error'))
    }

    const handleAbort = () => {
      cleanup()
      reject(signal?.reason ?? new Error('Ping aborted'))
    }

    function cleanup() {
      if (settled) return
      settled = true

      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      if (typeof port.removeEventListener === 'function') {
        port.removeEventListener('message', handleMessage)
        port.removeEventListener('messageerror', handleMessageError)
      }
      if (port.onmessage === handleMessage) {
        port.onmessage = null
      }
      if (port.onmessageerror === handleMessageError) {
        port.onmessageerror = null
      }
      if (signal) {
        signal.removeEventListener('abort', handleAbort)
      }
    }

    if (signal) {
      signal.addEventListener('abort', handleAbort, { once: true })
    }

    if (timeoutMs !== undefined && timeoutMs > 0) {
      timer = setTimeout(() => {
        cleanup()
        reject(new Error('Heartbeat timeout'))
      }, timeoutMs)
    }

    if (typeof port.addEventListener === 'function') {
      port.addEventListener('message', handleMessage)
      port.addEventListener('messageerror', handleMessageError)
    } else {
      port.onmessage = handleMessage
      port.onmessageerror = handleMessageError
    }

    if (typeof port.start === 'function') {
      port.start()
    }

    try {
      port.postMessage('ping')
    } catch (err) {
      cleanup()
      reject(err)
    }
  })
}

function isExternalAbort(signal: AbortSignal): boolean {
  if (!signal.aborted) return false
  const reason = signal.reason
  const msg = reason instanceof Error ? reason.message : String(reason)
  return msg !== 'Heartbeat timeout'
}

export class SyncWorkerHealthMonitor {
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private crashCount = 0
  private timeoutCrashCount = 0
  private lastCrashTime = 0
  private isPinging = false
  private activePingAbortController: AbortController | null = null
  private cleanupCurrentWorkerListeners: (() => void) | null = null
  private lastWorkerActivityTime = 0
  private consecutiveMissedPings = 0
  private lastTickTime = 0

  recordActivity = (): void => {
    this.lastWorkerActivityTime = Date.now()
    if (this.consecutiveMissedPings > 0) {
      this.consecutiveMissedPings = 0
      useAppStore.getState().clearSyncWarning()
    }
  }

  getLastWorkerActivityTime = (): number => {
    return this.lastWorkerActivityTime
  }

  stopWorkerHeartbeat = (): void => {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.activePingAbortController !== null) {
      this.activePingAbortController.abort(new Error('Heartbeat stopped'))
      this.activePingAbortController = null
    }
    if (this.cleanupCurrentWorkerListeners !== null) {
      this.cleanupCurrentWorkerListeners()
      this.cleanupCurrentWorkerListeners = null
    }
    this.isPinging = false
    this.consecutiveMissedPings = 0
  }

  resetCrashMetrics = (): void => {
    this.crashCount = 0
    this.timeoutCrashCount = 0
    this.lastCrashTime = 0
    this.consecutiveMissedPings = 0
    this.lastWorkerActivityTime = Date.now()
    this.lastTickTime = 0
  }

  handleWorkerCrash({
    worker,
    onCrash,
    onRestart,
    isTimeout = false,
  }: CrashDetails): void {
    this.stopWorkerHeartbeat()

    try {
      worker.terminate()
    } catch (err) {
      console.error('[SyncBridge] Error terminating crashed worker:', err)
    }

    const now = Date.now()
    if (now - this.lastCrashTime > CRASH_RESET_WINDOW_MS) {
      this.crashCount = 1
      this.timeoutCrashCount = isTimeout ? 1 : 0
    } else {
      this.crashCount += 1
      if (isTimeout) {
        this.timeoutCrashCount += 1
      }
    }
    this.lastCrashTime = now

    const maxAllowed = isTimeout ? MAX_CONSECUTIVE_TIMEOUTS : MAX_CONSECUTIVE_CRASHES
    const currentCount = isTimeout ? this.timeoutCrashCount : this.crashCount
    const willRestart = currentCount < maxAllowed

    onCrash(willRestart)

    if (!willRestart) {
      console.error(
        `[SyncBridge] Worker halted after ${currentCount} consecutive ${isTimeout ? 'timeouts' : 'crashes'}. Halting auto-restart.`
      )
      const errorMsg = isTimeout
        ? 'Sync worker became unresponsive repeatedly. Please refresh the page to try again.'
        : 'Sync worker crashed repeatedly. Please refresh the page to try again.'
      useAppStore.getState().setFatalError(errorMsg)
      useAppStore.getState().setSyncStatus('dead')
    } else {
      console.warn(
        `[SyncBridge] Attempting automatic restart (${isTimeout ? 'timeout' : 'crash'} count: ${currentCount}/${maxAllowed})...`
      )
      useAppStore.getState().setSyncStatus('connecting')
      useAppStore.getState().setSyncWarning('Sync connection lost. Reconnecting...')
      onRestart()
    }
  }

  setupWorkerHealthCheck = ({
    worker,
    pingPort,
    isCurrentWorker,
    onCrash,
    onRestart,
    heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
    heartbeatTimeoutMs = HEARTBEAT_TIMEOUT_MS,
    maxMissedPings = DEFAULT_MAX_MISSED_PINGS,
  }: HealthCheckOptions): void => {
    this.stopWorkerHeartbeat()

    const handleCrash = (isTimeout = false) => {
      if (!isCurrentWorker()) return
      this.handleWorkerCrash({ worker, onCrash, onRestart, isTimeout })
    }

    const handleError = (event: Event) => {
      console.error('[SyncBridge] Web worker error:', event)
      handleCrash(false)
    }

    const handleMsgError = (event: Event) => {
      console.error('[SyncBridge] Web worker message error:', event)
      handleCrash(false)
    }

    const handleVisibilityChange = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        this.lastTickTime = Date.now()
      }
    }

    worker.addEventListener('error', handleError)
    worker.addEventListener('messageerror', handleMsgError)
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange)
    }

    this.cleanupCurrentWorkerListeners = () => {
      worker.removeEventListener('error', handleError)
      worker.removeEventListener('messageerror', handleMsgError)
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange)
      }
    }

    this.lastTickTime = Date.now()
    this.lastWorkerActivityTime = Date.now()
    this.consecutiveMissedPings = 0

    this.heartbeatTimer = setInterval(async () => {
      if (!isCurrentWorker()) {
        this.stopWorkerHeartbeat()
        return
      }

      // 1. Tab visibility: skip heartbeat initiation if tab is backgrounded/hidden
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return
      }

      // 2. Sleep-wake / clock jump detection: if interval was delayed significantly, system slept or was throttled
      const now = Date.now()
      const timeSinceLastTick = now - this.lastTickTime
      this.lastTickTime = now

      if (timeSinceLastTick > heartbeatIntervalMs * 2.5) {
        console.warn(`[SyncBridge] Sleep/throttle detected (${timeSinceLastTick}ms elapsed since last tick). Discarding stale ping.`)
        if (this.isPinging && this.activePingAbortController) {
          this.activePingAbortController.abort(new Error('System sleep detected'))
        }
        this.isPinging = false
        this.consecutiveMissedPings = 0
        return
      }

      if (this.isPinging) {
        return
      }

      this.isPinging = true
      const abortController = new AbortController()
      this.activePingAbortController = abortController

      try {
        await sendPing(pingPort, {
          signal: abortController.signal,
          timeoutMs: heartbeatTimeoutMs,
        })

        // Ping succeeded
        this.consecutiveMissedPings = 0
        this.recordActivity()
      } catch (error) {
        if (!isCurrentWorker() || isExternalAbort(abortController.signal)) {
          return
        }

        // Check if system sleep / clock jump occurred while ping was in flight
        const nowAfterPing = Date.now()
        if (nowAfterPing - this.lastTickTime > heartbeatIntervalMs * 2.5) {
          console.warn('[SyncBridge] Sleep/throttle detected during ping. Discarding timeout.')
          this.consecutiveMissedPings = 0
          return
        }

        // 3. Activity awareness: if worker emitted events recently, it is alive and functional
        const timeSinceActivity = Date.now() - this.lastWorkerActivityTime
        if (timeSinceActivity < heartbeatTimeoutMs) {
          console.info(`[SyncBridge] Worker ping timed out but activity was observed ${timeSinceActivity}ms ago. Skipping crash.`)
          this.consecutiveMissedPings = 0
          return
        }

        // 4. Progressive confirmation before termination
        this.consecutiveMissedPings += 1
        if (this.consecutiveMissedPings < maxMissedPings) {
          console.warn(
            `[SyncBridge] Worker heartbeat missed (attempt ${this.consecutiveMissedPings}/${maxMissedPings}). Probing before termination...`
          )
          useAppStore.getState().setSyncWarning('Sync connection is slow. Checking...')
          return
        }

        console.error(`[SyncBridge] Worker heartbeat failed after ${this.consecutiveMissedPings} missed pings:`, error)
        handleCrash(true)
      } finally {
        if (this.activePingAbortController === abortController) {
          this.activePingAbortController = null
        }
        this.isPinging = false
      }
    }, heartbeatIntervalMs)
  }
}

export const defaultHealthMonitor = new SyncWorkerHealthMonitor()

export const recordWorkerActivity = (): void => {
  defaultHealthMonitor.recordActivity()
}

export const getLastWorkerActivityTime = (): number => {
  return defaultHealthMonitor.getLastWorkerActivityTime()
}

export const stopWorkerHeartbeat = (): void => {
  defaultHealthMonitor.stopWorkerHeartbeat()
}

export const resetCrashMetrics = (): void => {
  defaultHealthMonitor.resetCrashMetrics()
}

export const setupWorkerHealthCheck = (options: HealthCheckOptions): void => {
  defaultHealthMonitor.setupWorkerHealthCheck(options)
}
