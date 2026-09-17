import { useAppStore } from '../../state/store'

export const HEARTBEAT_INTERVAL_MS = 15000
export const HEARTBEAT_TIMEOUT_MS = 30000
export const MAX_CONSECUTIVE_CRASHES = 3
export const MAX_CONSECUTIVE_TIMEOUTS = 5
export const CRASH_RESET_WINDOW_MS = 60000
export const DEFAULT_MAX_MISSED_PINGS = 2

let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let crashCount = 0
let timeoutCrashCount = 0
let lastCrashTime = 0
let isPinging = false
let activePingAbortController: AbortController | null = null
let cleanupCurrentWorkerListeners: (() => void) | null = null
let lastWorkerActivityTime = 0
let consecutiveMissedPings = 0
let lastTickTime = 0

export const recordWorkerActivity = () => {
  lastWorkerActivityTime = Date.now()
  if (consecutiveMissedPings > 0) {
    consecutiveMissedPings = 0
    useAppStore.getState().clearSyncWarning()
  }
}

export const getLastWorkerActivityTime = (): number => lastWorkerActivityTime

export const stopWorkerHeartbeat = () => {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
  if (activePingAbortController !== null) {
    activePingAbortController.abort(new Error('Heartbeat stopped'))
    activePingAbortController = null
  }
  if (cleanupCurrentWorkerListeners !== null) {
    cleanupCurrentWorkerListeners()
    cleanupCurrentWorkerListeners = null
  }
  isPinging = false
  consecutiveMissedPings = 0
}

export const resetCrashMetrics = () => {
  crashCount = 0
  timeoutCrashCount = 0
  lastCrashTime = 0
  consecutiveMissedPings = 0
  lastWorkerActivityTime = Date.now()
  lastTickTime = 0
}

export interface SendPingOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export interface HealthCheckOptions {
  worker: Worker
  pingPort?: MessagePort
  pingFn?: (signal?: AbortSignal) => Promise<void>
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

function handleWorkerCrash({
  worker,
  onCrash,
  onRestart,
  isTimeout = false,
}: CrashDetails) {
  stopWorkerHeartbeat()

  try {
    worker.terminate()
  } catch (err) {
    console.error('[SyncBridge] Error terminating crashed worker:', err)
  }

  const now = Date.now()
  if (now - lastCrashTime > CRASH_RESET_WINDOW_MS) {
    crashCount = 1
    timeoutCrashCount = isTimeout ? 1 : 0
  } else {
    crashCount += 1
    if (isTimeout) {
      timeoutCrashCount += 1
    }
  }
  lastCrashTime = now

  const maxAllowed = isTimeout ? MAX_CONSECUTIVE_TIMEOUTS : MAX_CONSECUTIVE_CRASHES
  const currentCount = isTimeout ? timeoutCrashCount : crashCount
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

    const cleanup = () => {
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

export const setupWorkerHealthCheck = ({
  worker,
  pingPort,
  pingFn,
  isCurrentWorker,
  onCrash,
  onRestart,
  heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
  heartbeatTimeoutMs = HEARTBEAT_TIMEOUT_MS,
  maxMissedPings = DEFAULT_MAX_MISSED_PINGS,
}: HealthCheckOptions) => {
  stopWorkerHeartbeat()

  const handleCrash = (isTimeout = false) => {
    if (!isCurrentWorker()) return
    handleWorkerCrash({ worker, onCrash, onRestart, isTimeout })
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
      lastTickTime = Date.now()
    }
  }

  worker.addEventListener('error', handleError)
  worker.addEventListener('messageerror', handleMsgError)
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChange)
  }

  cleanupCurrentWorkerListeners = () => {
    worker.removeEventListener('error', handleError)
    worker.removeEventListener('messageerror', handleMsgError)
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }

  lastTickTime = Date.now()
  lastWorkerActivityTime = Date.now()
  consecutiveMissedPings = 0

  heartbeatTimer = setInterval(async () => {
    if (!isCurrentWorker()) {
      stopWorkerHeartbeat()
      return
    }

    // 1. Tab visibility: skip heartbeat initiation if tab is backgrounded/hidden
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      return
    }

    // 2. Sleep-wake / clock jump detection: if interval was delayed significantly, system slept or was throttled
    const now = Date.now()
    const timeSinceLastTick = now - lastTickTime
    lastTickTime = now

    if (timeSinceLastTick > heartbeatIntervalMs * 2.5) {
      console.warn(`[SyncBridge] Sleep/throttle detected (${timeSinceLastTick}ms elapsed since last tick). Discarding stale ping.`)
      if (isPinging && activePingAbortController) {
        activePingAbortController.abort(new Error('System sleep detected'))
      }
      isPinging = false
      consecutiveMissedPings = 0
      return
    }

    if (isPinging) {
      return
    }

    isPinging = true
    const abortController = new AbortController()
    activePingAbortController = abortController

    try {
      if (pingPort) {
        await sendPing(pingPort, {
          signal: abortController.signal,
          timeoutMs: heartbeatTimeoutMs,
        })
      } else if (pingFn) {
        let timeoutId: ReturnType<typeof setTimeout> | null = null
        try {
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
              const err = new Error('Heartbeat timeout')
              abortController.abort(err)
              reject(err)
            }, heartbeatTimeoutMs)
          })
          const pingPromise = pingFn(abortController.signal)
          pingPromise.catch(() => {})
          timeoutPromise.catch(() => {})
          await Promise.race([pingPromise, timeoutPromise])
        } finally {
          if (timeoutId !== null) {
            clearTimeout(timeoutId)
          }
        }
      }

      // Ping succeeded
      consecutiveMissedPings = 0
      recordWorkerActivity()
    } catch (error) {
      if (!isCurrentWorker() || isExternalAbort(abortController.signal)) {
        return
      }

      // Check if system sleep / clock jump occurred while ping was in flight
      const nowAfterPing = Date.now()
      if (nowAfterPing - lastTickTime > heartbeatIntervalMs * 2.5) {
        console.warn('[SyncBridge] Sleep/throttle detected during ping. Discarding timeout.')
        consecutiveMissedPings = 0
        return
      }

      // 3. Activity awareness: if worker emitted events recently, it is alive and functional
      const timeSinceActivity = Date.now() - lastWorkerActivityTime
      if (timeSinceActivity < heartbeatTimeoutMs) {
        console.info(`[SyncBridge] Worker ping timed out but activity was observed ${timeSinceActivity}ms ago. Skipping crash.`)
        consecutiveMissedPings = 0
        return
      }

      // 4. Progressive confirmation before termination
      consecutiveMissedPings += 1
      if (consecutiveMissedPings < maxMissedPings) {
        console.warn(
          `[SyncBridge] Worker heartbeat missed (attempt ${consecutiveMissedPings}/${maxMissedPings}). Probing before termination...`
        )
        useAppStore.getState().setSyncWarning('Sync connection is slow. Checking...')
        return
      }

      console.error(`[SyncBridge] Worker heartbeat failed after ${consecutiveMissedPings} missed pings:`, error)
      handleCrash(true)
    } finally {
      if (activePingAbortController === abortController) {
        activePingAbortController = null
      }
      isPinging = false
    }
  }, heartbeatIntervalMs)
}
