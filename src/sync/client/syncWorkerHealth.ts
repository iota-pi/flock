import { useAppStore } from '../../state/store'

let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let crashCount = 0
let lastCrashTime = 0
let isPinging = false
let activePingAbortController: AbortController | null = null
let cleanupCurrentWorkerListeners: (() => void) | null = null

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
}

export const resetCrashMetrics = () => {
  crashCount = 0
  lastCrashTime = 0
}

export interface SendPingOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

interface HealthCheckOptions {
  worker: Worker
  pingPort?: MessagePort
  pingFn?: (signal?: AbortSignal) => Promise<void>
  isCurrentWorker: () => boolean
  onCrash: (willRestart?: boolean) => void
  onRestart: () => void
}

function handleWorkerCrash({
  worker,
  onCrash,
  onRestart,
}: Omit<HealthCheckOptions, 'pingPort' | 'pingFn' | 'isCurrentWorker'>) {
  stopWorkerHeartbeat()

  try {
    worker.terminate()
  } catch (err) {
    console.error('[SyncBridge] Error terminating crashed worker:', err)
  }

  const now = Date.now()
  const CRASH_RESET_WINDOW_MS = 60000
  if (now - lastCrashTime > CRASH_RESET_WINDOW_MS) {
    crashCount = 1
  } else {
    crashCount += 1
  }
  lastCrashTime = now

  const MAX_CONSECUTIVE_CRASHES = 3
  const willRestart = crashCount < MAX_CONSECUTIVE_CRASHES

  onCrash(willRestart)

  if (!willRestart) {
    console.error(`[SyncBridge] Worker crashed consecutively ${crashCount} times. Halting auto-restart.`)
    useAppStore.getState().setFatalError(
      'Sync worker crashed repeatedly. Please refresh the page to try again.'
    )
    useAppStore.getState().setSyncStatus('dead')
  } else {
    console.warn(`[SyncBridge] Attempting automatic restart (crash count: ${crashCount}/${MAX_CONSECUTIVE_CRASHES})...`)
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

    const handleMessage = (event: MessageEvent) => {
      if (event.data === 'pong') {
        cleanup()
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
  if (reason instanceof Error) {
    return reason.message !== 'Heartbeat timeout'
  }
  return reason !== 'Heartbeat timeout'
}

export const setupWorkerHealthCheck = ({
  worker,
  pingPort,
  pingFn,
  isCurrentWorker,
  onCrash,
  onRestart,
}: HealthCheckOptions) => {
  stopWorkerHeartbeat()

  const handleCrash = () => {
    if (!isCurrentWorker()) return
    handleWorkerCrash({ worker, onCrash, onRestart })
  }

  const handleError = (event: Event) => {
    console.error('[SyncBridge] Web worker error:', event)
    handleCrash()
  }

  const handleMsgError = (event: Event) => {
    console.error('[SyncBridge] Web worker message error:', event)
    handleCrash()
  }

  worker.addEventListener('error', handleError)
  worker.addEventListener('messageerror', handleMsgError)

  cleanupCurrentWorkerListeners = () => {
    worker.removeEventListener('error', handleError)
    worker.removeEventListener('messageerror', handleMsgError)
  }

  const HEARTBEAT_INTERVAL_MS = 15000
  const HEARTBEAT_TIMEOUT_MS = 30000

  heartbeatTimer = setInterval(async () => {
    if (!isCurrentWorker()) {
      stopWorkerHeartbeat()
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
          timeoutMs: HEARTBEAT_TIMEOUT_MS,
        })
      } else if (pingFn) {
        let timeoutId: ReturnType<typeof setTimeout> | null = null
        try {
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
              const err = new Error('Heartbeat timeout')
              abortController.abort(err)
              reject(err)
            }, HEARTBEAT_TIMEOUT_MS)
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
    } catch (error) {
      if (!isCurrentWorker() || isExternalAbort(abortController.signal)) {
        return
      }
      console.error('[SyncBridge] Worker heartbeat failed:', error)
      handleCrash()
    } finally {
      if (activePingAbortController === abortController) {
        activePingAbortController = null
      }
      isPinging = false
    }
  }, HEARTBEAT_INTERVAL_MS)
}
