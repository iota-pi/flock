import { useAppStore } from '../../state/store'

let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let crashCount = 0
let lastCrashTime = 0
let isPinging = false

export const stopWorkerHeartbeat = () => {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
  isPinging = false
}

export const resetCrashMetrics = () => {
  crashCount = 0
  lastCrashTime = 0
}

interface HealthCheckOptions {
  worker: Worker
  pingPort?: MessagePort
  pingFn?: () => Promise<void>
  isCurrentWorker: () => boolean
  onCrash: () => void
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

  onCrash()

  const now = Date.now()
  const CRASH_RESET_WINDOW_MS = 60000
  if (now - lastCrashTime > CRASH_RESET_WINDOW_MS) {
    crashCount = 1
  } else {
    crashCount += 1
  }
  lastCrashTime = now

  const MAX_CONSECUTIVE_CRASHES = 3
  if (crashCount >= MAX_CONSECUTIVE_CRASHES) {
    console.error(`[SyncBridge] Worker crashed consecutively ${crashCount} times. Halting auto-restart.`)
    useAppStore.getState().setFatalError(
      'Sync worker crashed repeatedly. Please refresh the page to try again.'
    )
    useAppStore.getState().setSyncStatus('offline')
  } else {
    console.warn(`[SyncBridge] Attempting automatic restart (crash count: ${crashCount}/${MAX_CONSECUTIVE_CRASHES})...`)
    useAppStore.getState().setSyncStatus('connecting')
    useAppStore.getState().setSyncWarning('Sync connection lost. Reconnecting...')
    onRestart()
  }
}

const sendPing = (port: MessagePort): Promise<void> => {
  return new Promise<void>(resolve => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data === 'pong') {
        if (typeof port.removeEventListener === 'function') {
          port.removeEventListener('message', handleMessage)
        }
        resolve()
      }
    }
    if (typeof port.addEventListener === 'function') {
      port.addEventListener('message', handleMessage)
    } else {
      port.onmessage = handleMessage
    }
    if (typeof port.start === 'function') {
      port.start()
    }
    port.postMessage('ping')
  })
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

  worker.addEventListener('error', event => {
    console.error('[SyncBridge] Web worker error:', event)
    handleCrash()
  })

  worker.addEventListener('messageerror', event => {
    console.error('[SyncBridge] Web worker message error:', event)
    handleCrash()
  })

  const HEARTBEAT_INTERVAL_MS = 15000
  const HEARTBEAT_TIMEOUT_MS = 30000

  const performPing = pingPort
    ? () => sendPing(pingPort)
    : (pingFn ?? (() => Promise.resolve()))

  heartbeatTimer = setInterval(async () => {
    if (!isCurrentWorker()) {
      stopWorkerHeartbeat()
      return
    }

    if (isPinging) {
      return
    }

    isPinging = true
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    try {
      await Promise.race([
        performPing(),
        new Promise<void>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('Heartbeat timeout')), HEARTBEAT_TIMEOUT_MS)
        }),
      ])
    } catch (error) {
      console.error('[SyncBridge] Worker heartbeat failed:', error)
      handleCrash()
    } finally {
      isPinging = false
      if (timeoutId !== null) {
        clearTimeout(timeoutId)
      }
    }
  }, HEARTBEAT_INTERVAL_MS)
}
