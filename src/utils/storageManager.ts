import { isQuotaError } from './storageQuota'

type QuotaExceededListener = (message: string) => void

const listeners = new Set<QuotaExceededListener>()
let isQuotaExceeded = false
let lastReportedTime = 0
const REPORT_THROTTLE_MS = 10000 // 10 seconds

export function registerQuotaReporter(reporter: QuotaExceededListener): () => void {
  listeners.add(reporter)
  return () => {
    listeners.delete(reporter)
  }
}

export function reportQuotaExceeded(): void {
  isQuotaExceeded = true
  const now = Date.now()
  if (now - lastReportedTime < REPORT_THROTTLE_MS) {
    return
  }
  lastReportedTime = now
  const message =
    'Storage quota exceeded. Flock cannot save changes or synchronize, risking data loss. Please free up space and check your connection to sync.'
  for (const listener of listeners) {
    try {
      listener(message)
    } catch (err) {
      console.error('[StorageManager] Error in quota listener:', err)
    }
  }
}

export function getQuotaExceededStatus(): boolean {
  return isQuotaExceeded
}

export function resetQuotaExceededStatus(): void {
  isQuotaExceeded = false
}

export function checkQuotaExceeded(): boolean {
  if (isQuotaExceeded) {
    reportQuotaExceeded()
    return true
  }
  return false
}

/**
 * Runs a storage operation, intercepts IndexedDB write/quota errors, and reports them centrally.
 */
export async function runStorageOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (isQuotaError(error)) {
      reportQuotaExceeded()
    }
    throw error
  }
}
