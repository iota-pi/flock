import { useAppStore } from '../../state/store'

let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let crashCount = 0
let lastCrashTime = 0

export const stopWorkerHeartbeat = () => {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

export const resetCrashMetrics = () => {
  crashCount = 0
  lastCrashTime = 0
}

interface HealthCheckOptions {
  worker: Worker
  pingFn: () => Promise<void>
  isCurrentWorker: () => boolean
  onCrash: () => void
  onRestart: () => void
}

function handleWorkerCrash({
  worker,
  onCrash,
  onRestart,
}: Omit<HealthCheckOptions, 'pingFn' | 'isCurrentWorker'>) {
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

export const setupWorkerHealthCheck = ({
  worker,
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
  const HEARTBEAT_TIMEOUT_MS = 5000

  heartbeatTimer = setInterval(async () => {
    if (!isCurrentWorker()) {
      stopWorkerHeartbeat()
      return
    }

    try {
      await Promise.race([
        pingFn(),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('Heartbeat timeout')), HEARTBEAT_TIMEOUT_MS)
        ),
      ])
    } catch (error) {
      console.error('[SyncBridge] Worker heartbeat failed:', error)
      handleCrash()
    }
  }, HEARTBEAT_INTERVAL_MS)
}
